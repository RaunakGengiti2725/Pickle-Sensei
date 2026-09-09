import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * W08-01 adversarial attacks against candidate 6e47cefc.
 *
 * Every test drives the real ManageAccountScreen against a real SQLite
 * journal, the in-memory Keychain mock and a routed `globalThis.fetch` —
 * the same seams the shipping app uses. Each `it` is one attack at a
 * failure boundary; a failing assertion is a confirmed break of the
 * candidate, a passing one records an attack that did not break it.
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

const ORIGIN: string = (() => {
  const origin = getRuntimePublicConfig().apiBaseUrl;
  if (!origin) throw new Error('runtime config must expose the API origin');
  return origin;
})();

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const BEARER_A = 'session.bearer.owner-a';
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

type DeletionPath = 'delete-request' | 'delete-confirm' | 'delete-status';

const sessionA: AuthSession = {
  provider: 'google',
  subject: OWNER_A,
  canonicalAppUserId: OWNER_A,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

const realFetch = globalThis.fetch;
const mockFetch = jest.fn<Promise<Response>, [string, RequestInit]>();

function iso(offsetMs: number, from = Date.now()): string {
  return new Date(from + offsetMs).toISOString();
}

function requestPayload(operation = 10, serverNow = Date.now()) {
  return {
    challenge: deletionId(operation + 1),
    expiresAt: iso(900_000, serverNow),
    operationId: deletionId(operation),
    statusCapability: DELETION_CAPABILITY,
    statusExpiresAt: iso(DAY_MS, serverNow),
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

/** A reply shaped like React Native's fetch Response (no `redirected`
 * property; `url` = the URL the network stack actually answered). */
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
      'SELECT job_id, owner_id, operation_id, phase, revision, document FROM device_account_deletion_journal ORDER BY rowid',
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
  _renderer: TestRenderer.ReactTestRenderer,
  target: TestRenderer.ReactTestInstance,
) {
  const onPress: unknown = target.props.onPress;
  if (typeof onPress !== 'function') throw new Error('target is not pressable');
  await act(async () => {
    onPress();
  });
}

/** The countdown a paced button currently shows, or 0 when it is armed. */
function countdownOf(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): number {
  const paced = /\((\d+)\)$/.exec(
    String(sheetButton(renderer, label).props.label),
  );
  return paced ? Number(paced[1]) : 0;
}

async function pressWhenArmed(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const seconds = countdownOf(renderer, label);
  if (seconds > 0) {
    expect(sheetButton(renderer, label).props.disabled).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(seconds * 1000);
    });
  }
  expect(sheetButton(renderer, label).props.disabled).toBe(false);
  await press(renderer, sheetButton(renderer, label));
}

async function openDeleteSheet(renderer: TestRenderer.ReactTestRenderer) {
  await press(renderer, pressable(renderer, 'Delete account')[0]!);
  await act(async () => {});
}

async function openReview(renderer: TestRenderer.ReactTestRenderer) {
  await openDeleteSheet(renderer);
  await press(renderer, pressable(renderer, 'Skip the survey')[0]!);
}

async function armDeletion(renderer: TestRenderer.ReactTestRenderer) {
  await openReview(renderer);
  await press(renderer, sheetButton(renderer, 'Continue to delete'));
  await act(async () => {
    jest.advanceTimersByTime(5_000);
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

function expectUnknownOutcome(renderer: TestRenderer.ReactTestRenderer) {
  const text = allText(renderer);
  expect(text).toContain('Deletion status unknown');
  expect(text).not.toContain('Delete your account?');
  expect(text).not.toContain('Nothing was deleted');
  expect(text).not.toContain('Nothing has been deleted');
  expect(text).not.toContain('Keep my account');
  expect(
    sheetButtons(renderer, 'Permanently delete').filter(
      node => node.props.disabled !== true,
    ),
  ).toHaveLength(0);
  expect(sheetButton(renderer, 'Close').props.disabled).toBe(false);
}

function signIn(owner: string, bearer: string) {
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: ORIGIN,
    bearerToken: bearer,
    canonicalAppUserId: owner,
    provider: 'google',
  });
  useAuthStore.setState({
    session: { ...sessionA, subject: owner, canonicalAppUserId: owner },
  });
}

/** Drives one lost confirmation: request OK, confirm reply never arrives. */
async function loseConfirmation(renderer: TestRenderer.ReactTestRenderer) {
  route({
    'delete-request': () => reply('delete-request', requestPayload()),
    'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
  });
  await armDeletion(renderer);
  await press(renderer, sheetButton(renderer, 'Permanently delete'));
  expectUnknownOutcome(renderer);
  expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
}

describe('W08-01 attacks on the durable ManageAccount deletion path', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockDatabase = createSqliteTestDb();
    deletionKeychainStore.clear();
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockShowBrandNotice.mockClear();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    signIn(OWNER_A, BEARER_A);
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

  describe('ATTACK 1 — network timeout on the confirmation', () => {
    it('a confirmation whose reply lands after the 15s deadline is unknown, and the late receipt never completes the account', async () => {
      const late = deferred<Response>();
      let aborted = false;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': init => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
          });
          return late.promise;
        },
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(sheetButton(renderer, 'Deleting…').props.disabled).toBe(true);
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);

        // 14.999s: still deleting, nothing decided.
        await advance(14_999);
        expect(buttonLabels(renderer)).toContain('Deleting…');
        expectNotDeleted(renderer);

        // The deadline: the transport aborts and the outcome is unknown.
        await advance(1);
        expect(aborted).toBe(true);
        expectUnknownOutcome(renderer);
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);

        // The reply now arrives late with a verified-looking receipt: it
        // must be dropped — only a fresh status check may complete.
        await act(async () => {
          late.resolve(reply('delete-confirm', completionPayload()));
        });
        await act(async () => {});
        expectNotDeleted(renderer);
        expectUnknownOutcome(renderer);
        expect(calls('delete-confirm')).toHaveLength(1);

        // Recovery through status completes exactly once, no re-confirm.
        await pressWhenArmed(renderer, 'Retry deletion');
        expectDeleted(renderer);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-status')).toHaveLength(1);
        expect(journalRows()).toMatchObject([
          { phase: 'receipt_verified', operation_id: deletionId(10) },
        ]);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('a request whose reply never arrives is unknown after 15s and is retried under the SAME journal row, never a second row', async () => {
      const hang = deferred<Response>();
      let requests = 0;
      route({
        'delete-request': () => {
          requests += 1;
          return requests === 1
            ? hang.promise
            : reply('delete-request', requestPayload());
        },
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        await advance(15_000);
        const text = allText(renderer);
        expect(text).toContain('Nothing has been deleted');
        expect(text).not.toContain('Account deleted');
        expect(sheetButtons(renderer, 'Continue to delete')).toHaveLength(0);
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
        expect(sheetButton(renderer, 'Retry request').props.disabled).toBe(
          false,
        );
        expect(journalRows()).toMatchObject([
          { phase: 'request_unknown', operation_id: null },
        ]);
        const [row] = journalRows();

        // A late 200 for the first request changes nothing.
        await act(async () => {
          hang.resolve(reply('delete-request', requestPayload(77)));
        });
        await act(async () => {});
        expect(journalRows()).toMatchObject([
          { phase: 'request_unknown', operation_id: null },
        ]);

        await press(renderer, sheetButton(renderer, 'Retry request'));
        await advance(5_000);
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
        expect(journalRows()).toHaveLength(1);
        expect(journalRows()[0]).toMatchObject({
          job_id: row!.job_id,
          phase: 'ready',
          operation_id: deletionId(10),
        });
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectDeleted(renderer);
        expect(calls('delete-request')).toHaveLength(2);
        expect(calls('delete-confirm')).toHaveLength(1);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 2 — 429 with Retry-After at every boundary value', () => {
    it.each([
      ['120', 120],
      ['00007', 7],
      ['43200', 43_200],
      // Out of range / malformed values fall back to the 60s default.
      ['86401', 60],
      ['99999', 60],
      ['0', 60],
      ['-1', 60],
      ['1e3', 60],
      ['NaN', 60],
      ['Wed, 21 Oct 2026 07:28:00 GMT', 60],
      ['', 60],
    ])(
      'confirm 429 Retry-After %p paces the status check by %is and never re-sends the confirmation',
      async (header, seconds) => {
        route({
          'delete-request': () => reply('delete-request', requestPayload()),
          'delete-confirm': () =>
            reply('delete-confirm', { error: { message: 'slow down' } }, 429, {
              headers: { 'retry-after': header },
            }),
          'delete-status': () =>
            reply('delete-status', statusPayload('pending')),
        });
        const renderer = renderScreen();
        try {
          await armDeletion(renderer);
          await press(renderer, sheetButton(renderer, 'Permanently delete'));
          expectUnknownOutcome(renderer);
          expect(allText(renderer)).toContain(
            'The server asked us to wait before checking again.',
          );
          expect(countdownOf(renderer, 'Retry deletion')).toBe(seconds);
          expect(sheetButton(renderer, 'Retry deletion').props.disabled).toBe(
            true,
          );
          expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);

          // One second early: still paced, and nothing went out.
          await advance((seconds - 1) * 1000);
          expect(sheetButton(renderer, 'Retry deletion').props.disabled).toBe(
            true,
          );
          expect(calls('delete-status')).toHaveLength(0);
          expect(calls('delete-confirm')).toHaveLength(1);

          // At the deadline the STATUS is asked (never another confirm),
          // and a `pending` answer re-arms the same operation.
          await advance(1000);
          expect(sheetButton(renderer, 'Retry deletion').props.disabled).toBe(
            false,
          );
          await press(renderer, sheetButton(renderer, 'Retry deletion'));
          expect(calls('delete-status')).toHaveLength(1);
          expect(calls('delete-confirm')).toHaveLength(1);
          expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
          expect(journalRows()).toMatchObject([
            { phase: 'ready', operation_id: deletionId(10) },
          ]);
          expectNotDeleted(renderer);
        } finally {
          act(() => renderer.unmount());
        }
      },
    );

    it('request 429 with a 24h Retry-After is paced for the full day and the survey is never re-sent early', async () => {
      route({
        'delete-request': () =>
          reply('delete-request', { error: { message: 'slow down' } }, 429, {
            headers: { 'retry-after': '86400' },
          }),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        const text = allText(renderer);
        expect(text).toContain('Too many attempts');
        expect(text).toContain('Nothing was deleted');
        expect(sheetButtons(renderer, 'Continue to delete')).toHaveLength(0);
        expect(countdownOf(renderer, 'Retry request')).toBe(86_400);
        expect(sheetButton(renderer, 'Retry request').props.disabled).toBe(
          true,
        );
        await advance(DAY_MS - 1000);
        expect(sheetButton(renderer, 'Retry request').props.disabled).toBe(
          true,
        );
        expect(calls('delete-request')).toHaveLength(1);
        await advance(1000);
        expect(sheetButton(renderer, 'Retry request').props.disabled).toBe(
          false,
        );
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 3 — 5xx at every step', () => {
    it('503 on request, 502 on confirm and 500 on status stay honest, back off, and complete only from a real receipt', async () => {
      let requests = 0;
      let statuses = 0;
      route({
        'delete-request': () => {
          requests += 1;
          return requests === 1
            ? reply('delete-request', { error: { message: 'down' } }, 503)
            : reply('delete-request', requestPayload());
        },
        'delete-confirm': () =>
          reply('delete-confirm', { error: { message: 'bad gateway' } }, 502),
        'delete-status': () => {
          statuses += 1;
          return statuses === 1
            ? reply('delete-status', 'internal error', 500)
            : reply('delete-status', statusPayload('completed'));
        },
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expect(allText(renderer)).toContain('Nothing has been deleted');
        expect(allText(renderer)).not.toContain('Deletion status unknown');
        expect(sheetButtons(renderer, 'Continue to delete')).toHaveLength(0);
        expect(sheetButton(renderer, 'Retry request').props.disabled).toBe(
          false,
        );
        expect(journalRows()).toMatchObject([
          { phase: 'request_unknown', operation_id: null },
        ]);

        await press(renderer, sheetButton(renderer, 'Retry request'));
        await advance(5_000);
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
        expect(journalRows()).toHaveLength(1);

        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectUnknownOutcome(renderer);
        expect(journalRows()).toMatchObject([
          { phase: 'confirm_pending', operation_id: deletionId(10) },
        ]);
        expect(countdownOf(renderer, 'Retry deletion')).toBe(3);

        await pressWhenArmed(renderer, 'Retry deletion');
        expectUnknownOutcome(renderer);
        expect(countdownOf(renderer, 'Retry deletion')).toBe(6);
        expect(calls('delete-confirm')).toHaveLength(1);

        await pressWhenArmed(renderer, 'Retry deletion');
        expectDeleted(renderer);
        expect(calls('delete-request')).toHaveLength(2);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-status')).toHaveLength(2);
        expect(journalRows()).toHaveLength(1);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 4 — redirected / off-origin status replies', () => {
    it.each([
      [
        'answered from another origin',
        { url: 'https://attacker.example/v1/me/delete-status' },
      ],
      ['answered from another path on the API origin', { url: ORIGIN }],
      ['flagged redirected at the same URL', { redirected: true }],
      ['carrying no URL at all', { url: '' }],
    ])(
      'a `completed` status reply %s never completes the account',
      async (_label, options) => {
        const renderer = renderScreen();
        try {
          await loseConfirmation(renderer);
          route({
            'delete-status': () =>
              reply('delete-status', statusPayload('completed'), 200, options),
          });
          await pressWhenArmed(renderer, 'Retry deletion');
          expectNotDeleted(renderer);
          expectUnknownOutcome(renderer);
          expect(calls('delete-status')).toHaveLength(1);
          expect(journalRows()).toMatchObject([
            { phase: 'confirm_pending', operation_id: deletionId(10) },
          ]);
          expect(deletionKeychainStore.size).toBe(1);
          for (const item of deletionKeychainStore.values())
            expect(item.password).not.toContain('completedAt');

          // The honest status afterwards completes exactly once.
          route({
            'delete-status': () =>
              reply('delete-status', statusPayload('completed')),
          });
          await pressWhenArmed(renderer, 'Retry deletion');
          expectDeleted(renderer);
        } finally {
          act(() => renderer.unmount());
        }
      },
    );
  });

  describe('ATTACK 5 — replayed and duplicate identities', () => {
    it('a 200 confirmation naming another operation, or carrying a non-UTC receipt, is unknown and never deleted', async () => {
      let confirms = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => {
          confirms += 1;
          return confirms === 1
            ? reply('delete-confirm', completionPayload(99))
            : reply('delete-confirm', {
                ...completionPayload(),
                completionReceipt: { completedAt: '2026-09-09T02:00:00+02:00' },
              });
        },
        'delete-status': () => reply('delete-status', statusPayload('pending')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectNotDeleted(renderer);
        expectUnknownOutcome(renderer);
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);

        // Status says the server never got it: the same operation re-arms.
        await pressWhenArmed(renderer, 'Retry deletion');
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
        await pressWhenArmed(renderer, 'Permanently delete');
        expectNotDeleted(renderer);
        expectUnknownOutcome(renderer);
        expect(calls('delete-confirm')).toHaveLength(2);
        for (const init of calls('delete-confirm'))
          expect(JSON.parse(String(init.body))).toEqual({
            challenge: deletionId(11),
            operationId: deletionId(10),
          });
        expect(journalRows()).toHaveLength(1);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('a server that re-issues an operation id already journaled for this owner cannot corrupt the earlier row or fake a completion', async () => {
      // Row 1 reaches `confirm_pending` (lost reply); status then reports
      // it `superseded` — a terminal, provably-not-deleted end.
      const renderer = renderScreen();
      try {
        await loseConfirmation(renderer);
        route({
          'delete-status': () =>
            reply('delete-status', statusPayload('superseded')),
        });
        await pressWhenArmed(renderer, 'Retry deletion');
        expect(allText(renderer)).toContain('A newer deletion request');
        expect(journalRows()).toMatchObject([
          { phase: 'observing', operation_id: deletionId(10) },
        ]);

        // The replacement request replays the SAME operation id 10.
        let requests = 0;
        route({
          'delete-request': () => {
            requests += 1;
            return reply(
              'delete-request',
              requestPayload(requests === 1 ? 10 : 20),
            );
          },
          'delete-confirm': init => {
            const body = JSON.parse(String(init.body)) as {
              operationId: string;
            };
            return reply(
              'delete-confirm',
              completionPayload(Number(body.operationId.slice(-2))),
            );
          },
        });
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        await advance(5_000);
        const rows = journalRows();
        expect(rows).toHaveLength(2);
        // The superseded row is untouched by the duplicate.
        expect(rows[0]).toMatchObject({
          phase: 'observing',
          operation_id: deletionId(10),
        });
        expectNotDeleted(renderer);
        const text = allText(renderer);
        if (sheetButtons(renderer, 'Permanently delete').length > 0) {
          // Accepted: it must be bound to the new row, never row 1.
          expect(rows[1]).toMatchObject({
            phase: 'ready',
            operation_id: deletionId(10),
          });
        } else {
          // Refused: honest, and the user is not stuck — a retry reaches
          // the server again and a fresh id arms normally.
          expect(text).toMatch(/Nothing (was|has been) deleted/);
          expect(rows[1]).toMatchObject({ operation_id: null });
          await pressWhenArmed(renderer, 'Retry request');
          await advance(5_000);
          expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
          expect(journalRows()[1]).toMatchObject({
            phase: 'ready',
            operation_id: deletionId(20),
          });
        }
        await pressWhenArmed(renderer, 'Permanently delete');
        expectDeleted(renderer);
        expect(journalRows()[0]).toMatchObject({
          phase: 'observing',
          operation_id: deletionId(10),
        });
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 6 — device clock ahead of the server', () => {
    it('a phone whose clock runs 20 minutes ahead can still confirm a 15-minute challenge the server just minted (the server, not the device clock, owns expiry)', async () => {
      const serverNow = Date.now();
      // Every server timestamp is minted on SERVER time; the device clock
      // is 20 minutes ahead of it.
      jest.setSystemTime(serverNow + 20 * MINUTE_MS);
      route({
        'delete-request': () =>
          reply('delete-request', requestPayload(10, serverNow)),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        await advance(5_000);
        expect(journalRows()).toMatchObject([{ operation_id: deletionId(10) }]);
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
        await pressWhenArmed(renderer, 'Permanently delete');
        // The confirmation must reach the server — it decides expiry.
        expect({
          confirms: calls('delete-confirm').length,
          shown: allText(renderer).replace(/^.*Manage subscription /, ''),
        }).not.toMatchObject({ confirms: 0 });
        expect(calls('delete-confirm')).toHaveLength(1);
        expectDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('with the clock 20 minutes ahead a second attempt does not loop on "expired" without ever asking the server', async () => {
      const serverNow = Date.now();
      jest.setSystemTime(serverNow + 20 * MINUTE_MS);
      let operation = 10;
      route({
        'delete-request': () => {
          operation += 1;
          return reply('delete-request', requestPayload(operation, serverNow));
        },
        'delete-confirm': () => reply('delete-confirm', completionPayload(12)),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await press(renderer, sheetButton(renderer, 'Continue to delete'));
          await advance(5_000);
          if (sheetButtons(renderer, 'Permanently delete').length > 0)
            await pressWhenArmed(renderer, 'Permanently delete');
        }
        expect(calls('delete-request')).toHaveLength(2);
        // Two challenges minted and the server never asked once: the
        // device is locked out of deletion by its own clock.
        expect({
          confirms: calls('delete-confirm').length,
          shown: allText(renderer).replace(/^.*Manage subscription /, ''),
        }).not.toMatchObject({ confirms: 0 });
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 7 — corrupt / partial persisted state', () => {
    function forgedRow(phase: 'receipt_verified' | 'receipt_pending') {
      const now = Date.now();
      const document = {
        version: 1,
        jobId: deletionId(500),
        ownerId: OWNER_A,
        apiOrigin: ORIGIN,
        operationId: deletionId(10),
        revision: 4,
        phase,
        expiresAt: iso(900_000, now - 60_000),
        statusExpiresAt: iso(DAY_MS, now - 60_000),
        reviewAfterMs: now - 55_000,
        createdAtMs: now - 60_000,
        nextAttemptAtMs: 0,
        retryCount: 0,
        serverState: 'completed',
        lastIssue: null,
        receipt: {
          completedAt: iso(0, now - 30_000),
          appleAuthorizationRevocation: 'revoked',
        },
        cleanup: { completed: [], pending: null },
        ownership: { references: [], legacyMedia: 'unverified' },
      };
      return document;
    }

    async function createJournalTable() {
      // Let the foundation create its own table so the DDL is the real one.
      route({
        'delete-request': () =>
          reply('delete-request', { error: { message: 'down' } }, 503),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
      } finally {
        act(() => renderer.unmount());
      }
      mockDatabase.native
        .prepare('DELETE FROM device_account_deletion_journal')
        .run();
      mockFetch.mockReset();
      route({});
    }

    it('a journal row that claims a verified receipt while the Keychain (readable) holds NO record for it is a contradiction, not proof of deletion', async () => {
      await createJournalTable();
      const document = forgedRow('receipt_verified');
      mockDatabase.native
        .prepare(
          'INSERT INTO device_account_deletion_journal (job_id, owner_id, api_origin, operation_id, revision, phase, document) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          document.jobId,
          OWNER_A,
          ORIGIN,
          document.operationId,
          document.revision,
          document.phase,
          JSON.stringify(document),
        );
      expect(deletionKeychainStore.size).toBe(0);

      const renderer = renderScreen();
      try {
        await openDeleteSheet(renderer);
        // No server call, no Keychain corroboration: this row alone must
        // not sign the user out and purge the owner's local data.
        expect(mockFetch).not.toHaveBeenCalled();
        expect({
          completeAccountDeletionCalls: (
            useAuthStore.getState().completeAccountDeletion as jest.Mock
          ).mock.calls.length,
          notices: mockShowBrandNotice.mock.calls,
        }).toEqual({ completeAccountDeletionCalls: 0, notices: [] });
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('a journal row whose document disagrees with its indexed columns is unreadable, never resumed as a live challenge', async () => {
      await createJournalTable();
      const document = {
        ...forgedRow('receipt_pending'),
        phase: 'ready',
        serverState: 'pending',
        receipt: null,
      };
      mockDatabase.native
        .prepare(
          'INSERT INTO device_account_deletion_journal (job_id, owner_id, api_origin, operation_id, revision, phase, document) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          document.jobId,
          OWNER_A,
          ORIGIN,
          deletionId(66),
          document.revision,
          'confirm_pending',
          JSON.stringify(document),
        );
      route({
        'delete-request': () => reply('delete-request', requestPayload(20)),
        'delete-confirm': () => reply('delete-confirm', completionPayload(20)),
      });
      const renderer = renderScreen();
      try {
        await openDeleteSheet(renderer);
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
        expectNotDeleted(renderer);
        expect(calls('delete-confirm')).toHaveLength(0);
        expect(journalRows()).toHaveLength(1);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 8 — process death after a lost confirmation, relaunch past the status window', () => {
    it('a relaunch 2 days after a lost confirmation still lets the phone ask the server once (status or request) instead of a permanent device-local lockout', async () => {
      const renderer = renderScreen();
      try {
        await loseConfirmation(renderer);
      } finally {
        act(() => renderer.unmount());
      }
      // The server never received the confirmation; the account is present
      // and the bearer still authenticates. It would say so if asked.
      route({
        'delete-status': () => reply('delete-status', statusPayload('pending')),
        'delete-request': () => reply('delete-request', requestPayload(30)),
        'delete-confirm': () => reply('delete-confirm', completionPayload(30)),
      });
      const before =
        calls('delete-status').length + calls('delete-request').length;
      let lastShown = '';

      for (const gap of [2 * DAY_MS, 30 * DAY_MS, 365 * DAY_MS]) {
        await advance(gap);
        const relaunched = renderScreen();
        try {
          await openDeleteSheet(relaunched);
          const text = allText(relaunched);
          lastShown = text.replace(/^.*Manage subscription /, '');
          expect(text).not.toContain('Account deleted');
          const labels = buttonLabels(relaunched).filter(
            label => label !== 'Close',
          );
          if (labels.length > 0) await pressWhenArmed(relaunched, labels[0]!);
        } finally {
          act(() => relaunched.unmount());
        }
      }
      // Across three relaunches over a year the phone must have consulted
      // the server at least once; a device that never asks can never learn
      // the account is still present and never offers deletion again.
      expect({
        serverCallsDuringRelaunches:
          calls('delete-status').length +
          calls('delete-request').length -
          before,
        shownOnRelaunch: lastShown,
      }).not.toMatchObject({ serverCallsDuringRelaunches: 0 });
    });

    it('a confirm answered 429 with the maximum Retry-After (86400s, equal to the production status-capability lifetime) can still be resolved when the wait ends', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply('delete-confirm', { error: { message: 'slow down' } }, 429, {
            headers: { 'retry-after': '86400' },
          }),
        'delete-status': () => reply('delete-status', statusPayload('pending')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectUnknownOutcome(renderer);
        expect(countdownOf(renderer, 'Retry deletion')).toBe(86_400);
        await advance(86_400 * 1000);
        expect(sheetButton(renderer, 'Retry deletion').props.disabled).toBe(
          false,
        );
        await press(renderer, sheetButton(renderer, 'Retry deletion'));
        // The server told the phone exactly when to ask again; asking then
        // must reach the server rather than end in a device-side dead end.
        expect({
          statusCalls: calls('delete-status').length,
          shown: allText(renderer).replace(/^.*Manage subscription /, ''),
        }).not.toMatchObject({ statusCalls: 0 });
        expect(calls('delete-status')).toHaveLength(1);
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 9 — re-entrancy while the journal is being resumed', () => {
    it('a "Continue to delete" tap that lands while the journal read is still queued behind another transaction is not silently dropped', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
      });
      // Another writer holds the SQLite queue: the journal `list()` that
      // resume needs waits behind it.
      const hold = deferred<void>();
      void mockDatabase.db.transaction!(async () => {
        await hold.promise;
      });
      const renderer = renderScreen();
      try {
        await openDeleteSheet(renderer);
        await press(renderer, pressable(renderer, 'Skip the survey')[0]!);
        expect(sheetButtons(renderer, 'Continue to delete')).toHaveLength(1);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        // Release the queue; the resume finds nothing to resume.
        await act(async () => {
          hold.resolve();
        });
        await advance(5_000);
        // The tap must have started the request (or at least be visibly
        // pending) — a swallowed tap leaves the review page unchanged.
        expect({
          requests: calls('delete-request').length,
          buttons: buttonLabels(renderer),
          rows: journalRows().length,
        }).not.toMatchObject({ requests: 0 });
        expect(calls('delete-request')).toHaveLength(1);
        expect(journalRows()).toMatchObject([{ operation_id: deletionId(10) }]);
        await pressWhenArmed(renderer, 'Permanently delete');
        expectDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 10 — copy and accessibility of every deletion state', () => {
    const FORBIDDEN =
      /Android|Google Play|guest mode|Live Court|DUPR|SwingVision|PB Vision|Selkirk|JOOLA|\d+\s?% accura|best-in-class|world.class|#1\b/i;

    async function eachState(
      visit: (
        name: string,
        renderer: TestRenderer.ReactTestRenderer,
      ) => void | Promise<void>,
    ) {
      // request_unknown
      route({
        'delete-request': () =>
          reply('delete-request', { error: { message: 'down' } }, 503),
      });
      let renderer = renderScreen();
      try {
        await openDeleteSheet(renderer);
        await visit('survey', renderer);
        await press(renderer, pressable(renderer, 'Skip the survey')[0]!);
        await visit('review', renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        await visit('request_unknown', renderer);
      } finally {
        act(() => renderer.unmount());
      }
      mockDatabase.native
        .prepare('DELETE FROM device_account_deletion_journal')
        .run();

      // armed → confirm_unknown → in_progress → completed
      let confirms = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => {
          confirms += 1;
          return confirms === 1
            ? Promise.reject(new TypeError('Network lost'))
            : reply('delete-confirm', {}, 202, {
                headers: { 'retry-after': '3' },
              });
        },
        'delete-status': () =>
          reply('delete-status', statusPayload('in_progress')),
      });
      renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await visit('armed', renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await visit('confirm_unknown', renderer);
        route({
          'delete-status': () =>
            reply('delete-status', statusPayload('pending')),
        });
        await pressWhenArmed(renderer, 'Retry deletion');
        await pressWhenArmed(renderer, 'Permanently delete');
        await visit('in_progress', renderer);
      } finally {
        act(() => renderer.unmount());
      }
      await advance(2 * DAY_MS);
      renderer = renderScreen();
      try {
        await openDeleteSheet(renderer);
        await visit('status_window_closed', renderer);
      } finally {
        act(() => renderer.unmount());
      }
    }

    it('no deletion state names a forbidden platform, competitor or claim, and every button and close control is labelled', async () => {
      await eachState((name, renderer) => {
        const text = allText(renderer);
        expect(`${name}: ${text}`).not.toMatch(FORBIDDEN);
        for (const button of renderer.root.findAllByType(Button)) {
          expect(String(button.props.label).trim().length).toBeGreaterThan(0);
        }
        const closeControls = renderer.root.findAll(
          node =>
            typeof node.props.accessibilityLabel === 'string' &&
            /close|cancel/i.test(node.props.accessibilityLabel) &&
            typeof node.props.onPress === 'function',
        );
        expect(`${name}: ${closeControls.length} close controls`).not.toMatch(
          /: 0 close/,
        );
      });
    });

    it('unknown and in-progress states never claim the account is kept or deleted', async () => {
      await eachState((name, renderer) => {
        const text = allText(renderer);
        if (
          name === 'confirm_unknown' ||
          name === 'in_progress' ||
          name === 'status_window_closed'
        ) {
          expect(text).not.toContain('Account deleted');
          expect(text).not.toMatch(/Nothing (was|has been) deleted/);
          expect(text).not.toContain('Keep my account');
          expect(text).not.toContain('Delete your account?');
        }
        if (name === 'request_unknown') {
          expect(text).not.toContain('Deletion status unknown');
          expect(text).toMatch(/Nothing (was|has been) deleted/);
        }
      });
    });
  });
});
