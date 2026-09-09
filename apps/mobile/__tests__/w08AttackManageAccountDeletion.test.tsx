import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as Keychain from 'react-native-keychain';

/**
 * W08-01 adversarial suite against candidate a054a5bd.
 *
 * Every test here states the behaviour the objective promises ("honest
 * pending/failed/completed states; unknown state never renders as deleted";
 * idempotent re-entry) and drives the REAL ManageAccountScreen over the real
 * SQLite journal, the in-memory Keychain mock and a routed `globalThis.fetch`
 * — the same seams the candidate's own suite uses. A failing test is a
 * reproduced break; a passing test is an attack the candidate survived.
 *
 * Attack categories: restart/resume after a server refusal, crash-free
 * Keychain failure before a send, corrupt persisted Keychain state over a
 * verified receipt, copy, 429 + Retry-After pacing, far-future clock,
 * concurrency (double press), cross-account isolation, malformed responses
 * and process death between the 202 and the poll.
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

const ORIGIN = getRuntimePublicConfig().apiBaseUrl;
if (!ORIGIN) throw new Error('runtime config must expose the API origin');

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const BEARER_A = 'session.bearer.owner-a';
const BEARER_B = 'session.bearer.owner-b';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const SURVEY_TITLE = "What's making you leave?";
const IN_PROGRESS_TITLE = 'Deletion in progress';
const UNKNOWN_TITLE = 'Deletion status unknown';
const UNREADABLE = 'could not be read';
const WINDOW_CLOSED = 'The window for checking this deletion has closed';
const MAY_HAVE_COMPLETED =
  'We could not confirm whether your account was deleted';

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

function deletionInProgressError() {
  return {
    error: {
      code: 'account.deletion_in_progress',
      message:
        'Account deletion is already confirmed. Check its status before starting again.',
    },
  };
}

function rateLimitedError() {
  return { error: { code: 'rate_limited', message: 'Too many requests.' } };
}

/** A reply shaped like React Native's fetch Response. */
function reply(
  path: DeletionPath,
  payload: unknown,
  status = 200,
  options: {
    url?: string;
    headers?: Record<string, string>;
    text?: string;
  } = {},
): Response {
  const response: Record<string, unknown> = {
    status,
    ok: status >= 200 && status < 300,
    url: options.url ?? `${ORIGIN}/v1/me/${path}`,
    headers: {
      get: (name: string) => options.headers?.[name.toLowerCase()] ?? null,
    },
    text: async () => options.text ?? JSON.stringify(payload),
    json: async () => payload,
  };
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
      'SELECT job_id, owner_id, operation_id, phase, document FROM device_account_deletion_journal ORDER BY rowid',
    )
    .all() as Array<{
    job_id: string;
    owner_id: string;
    operation_id: string | null;
    phase: string;
    document: string;
  }>;
}

function journalDocument(row: { document: string }): Record<string, unknown> {
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

function resetCleanupSpies() {
  useAuthStore.setState({
    completeAccountDeletion: jest.fn(() => Promise.resolve()),
  });
  mockShowBrandNotice.mockClear();
}

function expectDeleted(renderer: TestRenderer.ReactTestRenderer) {
  expect(useAuthStore.getState().completeAccountDeletion).toHaveBeenCalledTimes(
    1,
  );
  expect(mockShowBrandNotice).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Account deleted' }),
  );
  expect(allText(renderer)).not.toContain(UNKNOWN_TITLE);
}

function expectNotDeleted(renderer: TestRenderer.ReactTestRenderer) {
  expect(
    useAuthStore.getState().completeAccountDeletion,
  ).not.toHaveBeenCalled();
  expect(mockShowBrandNotice).not.toHaveBeenCalled();
  expect(allText(renderer)).not.toContain('Account deleted');
}

/** The Keychain stops answering — reads throw the way
 * errSecInteractionNotAllowed / errSecNotAvailable surface — from `down()`
 * on; every call before that is real. Writes are left real so the request
 * step itself succeeds. */
function keychainReadOutage() {
  let down = false;
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
    restore: () => get.mockRestore(),
  };
}

describe('W08-01 attack: ManageAccount deletion failure boundaries (candidate a054a5bd)', () => {
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

  describe('A1 restart/resume: a 409 deletion_in_progress must not lock the device out forever', () => {
    /** Owner A's request is refused with 409 account.deletion_in_progress
     * (another device confirmed a deletion). The row is journaled as
     * `request_unknown` / lastIssue `in_progress` with no operation id. */
    async function refusedAsInProgress() {
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expect(allText(renderer)).toContain(IN_PROGRESS_TITLE);
        expect(buttonLabels(renderer)).toEqual(['Close']);
        expect(journalRows()).toMatchObject([
          { owner_id: OWNER_A, operation_id: null, phase: 'request_unknown' },
        ]);
        expect(journalDocument(journalRows()[0]!)).toMatchObject({
          lastIssue: 'in_progress',
        });
      } finally {
        act(() => renderer.unmount());
      }
    }

    it('eight days later, with the server ready to accept a request again, the sheet re-asks the server (or offers the survey) instead of replaying the stale 409 with only Close', async () => {
      let requests = 0;
      route({
        'delete-request': () => {
          requests += 1;
          return requests === 1
            ? reply('delete-request', deletionInProgressError(), 409)
            : reply('delete-request', requestPayload(20));
        },
      });
      await refusedAsInProgress();

      // The server's confirmed operation ended `blocked` and was swept after
      // its 7-day retention; a new request would now be accepted.
      await advance(8 * DAY_MS);
      const reopened = renderScreen();
      try {
        await openDeleteSheet(reopened);
        const text = allText(reopened);
        // Honest options after eight days: either the journal row is no
        // longer treated as the owner's live refusal (survey), or the
        // server is asked again. Replaying the frozen refusal is neither.
        const asked = calls('delete-request').length >= 2;
        const survey = text.includes(SURVEY_TITLE);
        expect({
          asked,
          survey,
          text,
          buttons: buttonLabels(reopened),
        }).toEqual(expect.objectContaining({ asked: true }));
        expect(text).not.toContain(IN_PROGRESS_TITLE);
        expectNotDeleted(reopened);
      } finally {
        act(() => reopened.unmount());
      }
    });

    it('relaunch after relaunch, the refusal row never re-asks the server, so the account cannot be deleted from this phone even once the server accepts', async () => {
      let requests = 0;
      route({
        'delete-request': () => {
          requests += 1;
          return requests === 1
            ? reply('delete-request', deletionInProgressError(), 409)
            : reply('delete-request', requestPayload(20));
        },
        'delete-confirm': () => reply('delete-confirm', completionPayload(20)),
      });
      await refusedAsInProgress();

      for (let launch = 0; launch < 3; launch += 1) {
        await advance(30 * DAY_MS);
        const again = renderScreen();
        try {
          await openDeleteSheet(again);
        } finally {
          act(() => again.unmount());
        }
      }
      // 90+ days on, the device has asked the server exactly once.
      expect(calls('delete-request').length).toBeGreaterThan(1);
    });
  });

  describe('A2 Keychain failure before the send: nothing sent must not read as "may have completed"', () => {
    it('a Keychain read failure when "Permanently delete" is pressed sends nothing and must not claim the deletion status is unknown', async () => {
      const keychain = keychainReadOutage();
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        expect(journalRows()).toMatchObject([{ phase: 'ready' }]);
        // Protected data becomes unavailable before the confirmation is
        // read from the Keychain: nothing can be sent.
        keychain.down();
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});

        expect(calls('delete-confirm')).toHaveLength(0);
        expect(journalRows()).toMatchObject([
          { operation_id: deletionId(10), phase: 'ready' },
        ]);
        expectNotDeleted(renderer);

        const text = allText(renderer);
        // No confirmation left the device, so "may have completed" is false.
        expect(text).not.toContain(UNKNOWN_TITLE);
        expect(text).not.toContain(MAY_HAVE_COMPLETED);
        expect(text).not.toContain('may have completed');
        expect(sheetButtons(renderer, 'Retry deletion')).toHaveLength(0);
      } finally {
        act(() => renderer.unmount());
        keychain.restore();
      }
    });

    it('a Keychain read failure before the send must not offer "Retry deletion" that only polls the status of a confirmation that was never sent', async () => {
      const keychain = keychainReadOutage();
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
        'delete-status': () => reply('delete-status', statusPayload('pending')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        keychain.down();
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});
        expect(calls('delete-confirm')).toHaveLength(0);
        // Whatever the sheet offers now, pressing it must never turn into a
        // status poll for an unsent confirmation while the row is `ready`.
        const retry = sheetButtons(renderer, 'Retry deletion');
        if (retry.length > 0) {
          await pressWhenArmed(renderer, 'Retry deletion');
        }
        expect(calls('delete-status')).toHaveLength(0);
        expect(journalRows()).toMatchObject([{ phase: 'ready' }]);
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
        keychain.restore();
      }
    });
  });

  describe('A3 corrupt persisted Keychain state over a transport-verified receipt', () => {
    async function completeNormally() {
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});
        expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
        expectDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
      resetCleanupSpies();
    }

    it('a Keychain item that has become unparseable garbage over a journaled verified receipt still completes from the receipt — never "could not be read… contact support" with the deleted account left signed in', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      await completeNormally();

      // The Keychain item is present but its payload is corrupt: it neither
      // agrees nor disagrees with the journaled receipt — it says nothing.
      expect(deletionKeychainStore.size).toBe(1);
      for (const [service, item] of deletionKeychainStore) {
        deletionKeychainStore.set(service, {
          ...item,
          password: '\u0000not-json\u0000',
        });
      }

      await advance(60_000);
      const relaunch = renderScreen();
      try {
        await openDeleteSheet(relaunch);
        const text = allText(relaunch);
        expect(text).not.toContain(UNREADABLE);
        expect(text).not.toContain('contact support');
        expect(text).not.toContain(WINDOW_CLOSED);
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);
        expectDeleted(relaunch);
      } finally {
        act(() => relaunch.unmount());
      }
    });

    it('a Keychain item of an unsupported record version over a journaled verified receipt still completes from the receipt', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      await completeNormally();
      for (const [service, item] of deletionKeychainStore) {
        const record = JSON.parse(item.password) as Record<string, unknown>;
        deletionKeychainStore.set(service, {
          ...item,
          password: JSON.stringify({ ...record, version: 2 }),
        });
      }
      const relaunch = renderScreen();
      try {
        await openDeleteSheet(relaunch);
        expect(allText(relaunch)).not.toContain(UNREADABLE);
        expectDeleted(relaunch);
      } finally {
        act(() => relaunch.unmount());
      }
    });
  });

  describe('A4 copy: a refused request must not say "nothing was deleted" twice', () => {
    it.each([
      [
        '429 rate limited',
        () => reply('delete-request', rateLimitedError(), 429),
      ],
      [
        '400 rejected',
        () => reply('delete-request', { error: { message: 'bad' } }, 400),
      ],
    ])('%s', async (_name, respond) => {
      route({ 'delete-request': respond });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        const text = allText(renderer);
        expectNotDeleted(renderer);
        expect(text).not.toMatch(
          /Nothing was deleted\.? Nothing has been deleted/,
        );
        expect(text).not.toMatch(
          /Nothing has been deleted\.? Nothing was deleted/,
        );
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('A5 429 + Retry-After on the request: the retry must be paced like every other retry', () => {
    it('after a 429 with Retry-After: 3600 the "Retry request" button is paced (disabled with a countdown) instead of an enabled button that sends nothing', async () => {
      route({
        'delete-request': () =>
          reply('delete-request', rateLimitedError(), 429, {
            headers: { 'retry-after': '3600' },
          }),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expect(calls('delete-request')).toHaveLength(1);
        expect(journalRows()).toMatchObject([{ phase: 'request_unknown' }]);
        const retry = sheetButton(renderer, 'Retry request');
        // Pressing must either be refused up front (disabled) or reach the
        // server; a live button whose press does nothing is neither.
        if (retry.props.disabled !== true) {
          await press(renderer, retry);
          await act(async () => {});
          expect(calls('delete-request')).toHaveLength(2);
        }
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('Retry-After values outside the accepted range (0, 99999, -1, 1.5, text) never crash the sheet and leave the request retryable', async () => {
      for (const value of [
        '0',
        '99999',
        '-1',
        '1.5',
        'Wed, 21 Oct 2015 07:28:00 GMT',
      ]) {
        let attempts = 0;
        route({
          'delete-request': () => {
            attempts += 1;
            return attempts === 1
              ? reply('delete-request', rateLimitedError(), 429, {
                  headers: { 'retry-after': value },
                })
              : reply('delete-request', requestPayload(20));
          },
        });
        const renderer = renderScreen();
        try {
          await openReview(renderer);
          await press(renderer, sheetButton(renderer, 'Continue to delete'));
          expect(journalRows()).toMatchObject([{ phase: 'request_unknown' }]);
          expectNotDeleted(renderer);
          // The default 60s pacing (or the accepted value) elapses; the
          // retry then goes out under the same job.
          await advance(61_000);
          await press(renderer, sheetButton(renderer, 'Retry request'));
          await act(async () => {});
          expect(attempts).toBe(2);
          expect(journalRows()).toMatchObject([
            { operation_id: deletionId(20), phase: 'ready' },
          ]);
        } finally {
          act(() => renderer.unmount());
          mockDatabase.close();
          mockDatabase = createSqliteTestDb();
          deletionKeychainStore.clear();
          mockFetch.mockReset();
        }
      }
    });
  });

  describe('A6 far-future device clock after a sent confirmation', () => {
    it('a device clock that jumps 25h forward after a lost confirmation asks the server once before declaring the status window closed', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () => reply('delete-status', statusPayload('pending')),
      });
      const first = renderScreen();
      try {
        await armDeletion(first);
        await press(first, sheetButton(first, 'Permanently delete'));
        expect(allText(first)).toContain(UNKNOWN_TITLE);
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      } finally {
        act(() => first.unmount());
      }

      // The user sets the date forward (or the clock resyncs). The server's
      // window is measured on the server's clock and is still open.
      await advance(25 * HOUR_MS);
      const relaunch = renderScreen();
      try {
        await openDeleteSheet(relaunch);
        if (sheetButtons(relaunch, 'Retry deletion').length > 0)
          await pressWhenArmed(relaunch, 'Retry deletion');
        expect(calls('delete-status').length).toBeGreaterThanOrEqual(1);
        expectNotDeleted(relaunch);
      } finally {
        act(() => relaunch.unmount());
      }
    });

    it('a device clock rolled back 10 days after a request keeps the challenge honest: the server answers, the sheet never claims deleted', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply(
            'delete-confirm',
            {
              error: {
                code: 'account.deletion_challenge_expired',
                message: 'expired',
              },
            },
            403,
          ),
        'delete-status': () => reply('delete-status', statusPayload('expired')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        jest.setSystemTime(Date.now() - 10 * DAY_MS);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});
        expectNotDeleted(renderer);
        expect(allText(renderer)).not.toContain('Account deleted');
        // Either the sheet re-armed nothing (unknown) or reports expiry;
        // it must never render a completed deletion from a 403.
        expect(
          useAuthStore.getState().completeAccountDeletion,
        ).not.toHaveBeenCalled();
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('A7 concurrency: repeated presses on the retry paths', () => {
    it('two presses of "Retry request" in one frame send one request and journal one operation', async () => {
      let attempts = 0;
      route({
        'delete-request': () => {
          attempts += 1;
          return attempts === 1
            ? reply('delete-request', { error: { message: 'down' } }, 503)
            : reply('delete-request', requestPayload(attempts * 10));
        },
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expect(journalRows()).toMatchObject([{ phase: 'request_unknown' }]);
        const retry = sheetButton(renderer, 'Retry request');
        await act(async () => {
          retry.props.onPress();
          retry.props.onPress();
        });
        await act(async () => {});
        expect(calls('delete-request')).toHaveLength(2);
        expect(journalRows()).toMatchObject([
          { operation_id: deletionId(20), phase: 'ready' },
        ]);
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('two presses of "Retry deletion" in one frame after a lost confirmation issue one status call and complete once', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(allText(renderer)).toContain(UNKNOWN_TITLE);
        const label = String(
          sheetButton(renderer, 'Retry deletion').props.label,
        );
        const paced = /\((\d+)\)$/.exec(label);
        if (paced) await advance(Number(paced[1]) * 1000);
        const retry = sheetButton(renderer, 'Retry deletion');
        await act(async () => {
          retry.props.onPress();
          retry.props.onPress();
        });
        await act(async () => {});
        expect(calls('delete-status')).toHaveLength(1);
        expect(
          useAuthStore.getState().completeAccountDeletion,
        ).toHaveBeenCalledTimes(1);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('A8 cross-account isolation of refusal and unknown rows', () => {
    it("owner B never inherits owner A's 409 in-progress refusal: B sees the survey and mints B's own request", async () => {
      let requests = 0;
      route({
        'delete-request': init => {
          requests += 1;
          const bearer = (init.headers as Record<string, string>).Authorization;
          if (bearer === `Bearer ${BEARER_A}`)
            return reply('delete-request', deletionInProgressError(), 409);
          return reply('delete-request', requestPayload(30));
        },
      });
      const first = renderScreen();
      try {
        await openReview(first);
        await press(first, sheetButton(first, 'Continue to delete'));
        expect(allText(first)).toContain(IN_PROGRESS_TITLE);
      } finally {
        act(() => first.unmount());
      }

      signIn(OWNER_B, BEARER_B, 'apple');
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expect(allText(second)).toContain(SURVEY_TITLE);
        expect(allText(second)).not.toContain(IN_PROGRESS_TITLE);
        await press(second, pressable(second, 'Skip the survey')[0]!);
        await press(second, sheetButton(second, 'Continue to delete'));
        expect(requests).toBe(2);
        expect(journalRows()).toMatchObject([
          { owner_id: OWNER_A, phase: 'request_unknown' },
          { owner_id: OWNER_B, operation_id: deletionId(30), phase: 'ready' },
        ]);
        expectNotDeleted(second);
      } finally {
        act(() => second.unmount());
      }
    });

    it("owner A's lost confirmation stays A's: B sees the survey, and A's row is untouched by B's request", async () => {
      route({
        'delete-request': init => {
          const bearer = (init.headers as Record<string, string>).Authorization;
          return reply(
            'delete-request',
            requestPayload(bearer === `Bearer ${BEARER_A}` ? 10 : 30),
          );
        },
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      });
      const first = renderScreen();
      try {
        await armDeletion(first);
        await press(first, sheetButton(first, 'Permanently delete'));
        expect(allText(first)).toContain(UNKNOWN_TITLE);
      } finally {
        act(() => first.unmount());
      }
      const before = journalRows()[0]!;

      signIn(OWNER_B, BEARER_B, 'apple');
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expect(allText(second)).toContain(SURVEY_TITLE);
        await press(second, pressable(second, 'Skip the survey')[0]!);
        await press(second, sheetButton(second, 'Continue to delete'));
        expect(journalRows()).toHaveLength(2);
        expect(journalRows()[0]).toEqual(before);
        expectNotDeleted(second);
      } finally {
        act(() => second.unmount());
      }
    });
  });

  describe('A9 malformed / oversized responses', () => {
    it('a 200 confirmation whose body is not JSON keeps the outcome unknown (never deleted, never re-armed)', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply('delete-confirm', null, 200, { text: '<html>ok</html>' }),
        'delete-status': () =>
          reply('delete-status', statusPayload('in_progress')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});
        expectNotDeleted(renderer);
        expect(allText(renderer)).toContain(UNKNOWN_TITLE);
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
        expect(allText(renderer)).not.toContain('Keep my account');
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('a 200 request reply with a huge declared Content-Length is refused and the request stays retryable under the same job', async () => {
      let attempts = 0;
      route({
        'delete-request': () => {
          attempts += 1;
          return attempts === 1
            ? reply('delete-request', requestPayload(), 200, {
                headers: { 'content-length': String(64 * 1024 * 1024) },
              })
            : reply('delete-request', requestPayload(20));
        },
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
        expect(journalRows()).toMatchObject([
          { operation_id: null, phase: 'request_unknown' },
        ]);
        await press(renderer, sheetButton(renderer, 'Retry request'));
        expect(journalRows()).toMatchObject([
          { operation_id: deletionId(20), phase: 'ready' },
        ]);
        expect(journalRows()).toHaveLength(1);
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('a completed status whose receipt names a different completedAt than the journaled one still ends completed exactly once, never as a crash or unknown', async () => {
      let confirms = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => {
          confirms += 1;
          return reply('delete-confirm', completionPayload());
        },
        'delete-status': () =>
          reply('delete-status', {
            state: 'completed',
            completionReceipt: { completedAt: iso(-HOUR_MS) },
            appleAuthorizationRevocation: 'not_applicable',
          }),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});
        expectDeleted(renderer);
        expect(confirms).toBe(1);
      } finally {
        act(() => renderer.unmount());
      }
      resetCleanupSpies();
      const relaunch = renderScreen();
      try {
        await openDeleteSheet(relaunch);
        expectDeleted(relaunch);
        expect(allText(relaunch)).not.toContain(UNREADABLE);
      } finally {
        act(() => relaunch.unmount());
      }
    });
  });

  describe('A10 process death between the 202 in-progress reply and the poll', () => {
    it('relaunching over an `observing` row polls the status and completes only from the receipt', async () => {
      let statusCalls = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply(
            'delete-confirm',
            { operationId: deletionId(10), state: 'in_progress' },
            202,
            { headers: { 'retry-after': '3' } },
          ),
        'delete-status': () => {
          statusCalls += 1;
          return reply(
            'delete-status',
            statusPayload(statusCalls < 2 ? 'in_progress' : 'completed'),
          );
        },
      });
      const first = renderScreen();
      try {
        await armDeletion(first);
        await press(first, sheetButton(first, 'Permanently delete'));
        await act(async () => {});
        expect(allText(first)).toContain(IN_PROGRESS_TITLE);
        expect(journalRows()).toMatchObject([{ phase: 'observing' }]);
        expectNotDeleted(first);
      } finally {
        // The process dies before the 3s poll fires.
        act(() => first.unmount());
      }
      expect(calls('delete-status')).toHaveLength(0);

      const relaunch = renderScreen();
      try {
        await openDeleteSheet(relaunch);
        expect(allText(relaunch)).toContain(IN_PROGRESS_TITLE);
        expectNotDeleted(relaunch);
        await advance(3_000);
        await advance(3_000);
        expect(calls('delete-status').length).toBeGreaterThanOrEqual(2);
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);
        expectDeleted(relaunch);
      } finally {
        act(() => relaunch.unmount());
      }
    });
  });
});
