import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * W08-01 adversarial tests against candidate 4d0f5fab. Each test drives the
 * real ManageAccountScreen over the real SQLite journal, the in-memory
 * Keychain mock and a routed `globalThis.fetch` — the same seams as the
 * candidate's own suite — and probes one failure boundary the candidate's
 * tests do not pin:
 *   - a 429 refusing the FIRST durable confirmation (parity with fallback);
 *   - a device clock that rolls back after arming / after a paced refusal;
 *   - the dialog torn down while a confirmation is still in flight;
 *   - a confirmation that times out and whose reply arrives late;
 *   - Retry-After boundary values on a 202 in-progress answer, and a 202
 *     naming another operation;
 *   - a 5xx confirmation followed by a status of in_progress;
 *   - the exit survey across a relaunch of an unanswered request;
 *   - the fallback client on a 202 in-progress confirmation;
 *   - a double tap on "Retry deletion".
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
const BEARER_A = 'session.bearer.owner-a';
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

function inProgressPayload(operation = 10) {
  return { operationId: deletionId(operation), state: 'in_progress' };
}

function statusPayload(state: string) {
  return {
    state,
    completionReceipt: state === 'completed' ? { completedAt: iso(0) } : null,
    appleAuthorizationRevocation: state === 'completed' ? 'revoked' : null,
  };
}

/** A reply shaped like React Native's fetch Response: no `redirected`
 * property, `url` = the URL the network stack actually answered. */
function reply(
  path: DeletionPath,
  payload: unknown,
  status = 200,
  options: { headers?: Record<string, string> } = {},
): Response {
  const response: Record<string, unknown> = {
    status,
    ok: status >= 200 && status < 300,
    url: `${ORIGIN}/v1/me/${path}`,
    headers: {
      get: (name: string) => options.headers?.[name.toLowerCase()] ?? null,
    },
    text: async () => JSON.stringify(payload),
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

function bodyOf(init: RequestInit): unknown {
  return JSON.parse(String(init.body));
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

function buttonLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Button)
    .map(node => String(node.props.label));
}

/** The countdown a paced button shows, or 0 when it is armed. */
function countdownOf(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): number {
  const paced = /\((\d+)\)$/.exec(
    String(sheetButton(renderer, label).props.label),
  );
  return paced ? Number(paced[1]) : 0;
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
  const paced = countdownOf(renderer, label);
  if (paced > 0) {
    expect(sheetButton(renderer, label).props.disabled).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(paced * 1000);
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

function expectDeletedOnce(renderer: TestRenderer.ReactTestRenderer) {
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

function tooManyRequests(path: DeletionPath, retryAfter?: string) {
  return reply(
    path,
    { error: { message: 'Too many requests.' } },
    429,
    retryAfter === undefined ? {} : { headers: { 'retry-after': retryAfter } },
  );
}

/** Edge API confirmAccountDeletion when the challenge is confirmed inside
 * the server's review pause (`too_fast`): a refusal that acted on nothing. */
function tooFastError() {
  return reply(
    'delete-confirm',
    {
      error: {
        code: 'account.deletion_too_fast',
        message: 'Please review the confirmation before deleting.',
      },
    },
    429,
  );
}

describe('W08-01 adversarial: ManageAccount deletion failure boundaries', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockDatabase = createSqliteTestDb();
    mockDatabaseUnavailable = false;
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

  it.each([
    ['429 account.deletion_too_fast', tooFastError],
    ['429 rate limit', () => tooManyRequests('delete-confirm')],
  ])(
    'A1 durable: a %s refusing the FIRST confirmation is a known outcome (the server acted on nothing) — same challenge re-armed, no "may have completed", no 60 s wait; parity with the fallback path',
    async (_label, refusal) => {
      let confirmAttempts = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => {
          confirmAttempts += 1;
          return confirmAttempts === 1
            ? refusal()
            : reply('delete-confirm', completionPayload());
        },
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(calls('delete-confirm')).toHaveLength(1);
        expectNotDeleted(renderer);

        // The 429 is a refusal to act: the fallback path (candidate's own test
        // 'fallback: a 429 refusing the first confirmation re-arms the SAME
        // challenge') shows it as a known, nothing-deleted outcome. The
        // durable path must agree — no unknown-outcome copy, no blocked
        // "Retry deletion", the same challenge re-armed within the pacing.
        const text = allText(renderer);
        expect(text).not.toContain('Deletion status unknown');
        expect(text).not.toContain('may have completed');
        expect(text).toContain('Delete your account?');
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
        expect(countdownOf(renderer, 'Permanently delete')).toBeLessThanOrEqual(
          5,
        );

        await pressWhenArmed(renderer, 'Permanently delete');
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(2);
        expect(bodyOf(calls('delete-confirm')[1]!)).toEqual({
          challenge: deletionId(11),
          operationId: deletionId(10),
        });
        expectDeletedOnce(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    },
  );

  it('A2a clock rollback after arming: the review pause never grows past the 5 s the design allows, and the same challenge is confirmed', async () => {
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
      // The device clock is corrected backwards by an hour (NTP / manual)
      // between arming and the tap.
      jest.setSystemTime(Date.now() - HOUR_MS);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));

      expectNotDeleted(renderer);
      // Either the confirmation went out, or the review pause was re-armed
      // for at most the design's 5 s — never an hour-long lock.
      if (calls('delete-confirm').length === 0) {
        expect(allText(renderer)).toContain('Delete your account?');
        expect(countdownOf(renderer, 'Permanently delete')).toBeLessThanOrEqual(
          5,
        );
        await pressWhenArmed(renderer, 'Permanently delete');
      }
      expect(calls('delete-request')).toHaveLength(1);
      expect(calls('delete-confirm')).toHaveLength(1);
      expectDeletedOnce(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A2b clock rollback after a paced 429 on the request: the wait never exceeds the Retry-After the server asked for', async () => {
    let requestAttempts = 0;
    route({
      'delete-request': () => {
        requestAttempts += 1;
        return requestAttempts === 1
          ? tooManyRequests('delete-request', '60')
          : reply('delete-request', requestPayload(20));
      },
    });
    const renderer = renderScreen();
    try {
      await openReview(renderer);
      await press(renderer, sheetButton(renderer, 'Continue to delete'));
      expect(countdownOf(renderer, 'Retry request')).toBe(60);
      expectNotDeleted(renderer);

      // Close, roll the clock back an hour, re-open: the journal's absolute
      // deadline is now an hour further away than the server asked.
      await press(renderer, sheetButton(renderer, 'Keep my account'));
      jest.setSystemTime(Date.now() - HOUR_MS);
      await openDeleteSheet(renderer);
      expect(allText(renderer)).not.toContain("What's making you leave?");
      expect(countdownOf(renderer, 'Retry request')).toBeLessThanOrEqual(60);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A3 teardown while the confirmation is in flight: the next presentation says the outcome is unknown — never that the signed-in account changed — and completes once the reply lands', async () => {
    const confirmReply = deferred<Response>();
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => confirmReply.promise,
      'delete-status': () => reply('delete-status', statusPayload('completed')),
    });
    const first = renderScreen();
    await armDeletion(first);
    await press(first, sheetButton(first, 'Permanently delete'));
    expect(calls('delete-confirm')).toHaveLength(1);
    expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
    act(() => first.unmount());

    const second = renderScreen();
    try {
      await openDeleteSheet(second);
      expectNotDeleted(second);
      expectUnknownOutcome(second);
      // The owner never changed; the confirmation this phone sent is simply
      // still outstanding. Saying the account changed sends the player to
      // "start again for the account you want to delete" — a second request
      // over a confirmation that may already be deleting the account.
      expect(allText(second)).not.toContain('The signed-in account changed');
      expect(allText(second)).not.toContain('start again');

      // The lost dialog's reply arrives: a verified completion.
      await act(async () => {
        confirmReply.resolve(reply('delete-confirm', completionPayload()));
      });
      await act(async () => {});
      // Whether the first presentation or the second reports it, the account
      // is deleted exactly once and never re-armed.
      if (
        (useAuthStore.getState().completeAccountDeletion as jest.Mock).mock
          .calls.length === 0
      ) {
        await pressWhenArmed(second, 'Retry deletion');
      }
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      expect(calls('delete-request')).toHaveLength(1);
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
    } finally {
      act(() => second.unmount());
    }
  });

  it('A4 confirmation timeout: after 15 s the outcome is unknown, the late reply is not double-counted, and the status receipt completes exactly once', async () => {
    const confirmReply = deferred<Response>();
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => confirmReply.promise,
      'delete-status': () => reply('delete-status', statusPayload('completed')),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expect(allText(renderer)).toContain('Deleting');
      await act(async () => {
        jest.advanceTimersByTime(14_999);
      });
      expect(allText(renderer)).toContain('Deleting');
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      await act(async () => {});
      expectUnknownOutcome(renderer);
      expectNotDeleted(renderer);
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);

      // The reply the transport already gave up on arrives late.
      await act(async () => {
        confirmReply.resolve(reply('delete-confirm', completionPayload()));
      });
      await act(async () => {});
      expectNotDeleted(renderer);
      expectUnknownOutcome(renderer);

      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-status')).toHaveLength(1);
      expect(calls('delete-confirm')).toHaveLength(1);
      expectDeletedOnce(renderer);
      expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it.each([
    ['0', 3],
    ['-5', 3],
    ['abc', 3],
    ['99999', 3],
    ['Wed, 21 Oct 2026 07:28:00 GMT', 3],
    ['3600', 3600],
  ])(
    'A5a 202 in-progress with Retry-After %p: polling is paced at %d s — never 0 ms, never NaN, never a status storm',
    async (retryAfter, seconds) => {
      let statusAttempts = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply('delete-confirm', inProgressPayload(), 202, {
            headers: { 'retry-after': retryAfter },
          }),
        'delete-status': () => {
          statusAttempts += 1;
          return reply(
            'delete-status',
            statusPayload(statusAttempts === 1 ? 'in_progress' : 'completed'),
          );
        },
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(allText(renderer)).toContain('Deletion in progress');
        expectNotDeleted(renderer);
        expect(buttonLabels(renderer)).toEqual(['Close']);
        expect(calls('delete-status')).toHaveLength(0);

        await act(async () => {
          jest.advanceTimersByTime(seconds * 1000 - 1);
        });
        expect(calls('delete-status')).toHaveLength(0);
        await act(async () => {
          jest.advanceTimersByTime(1);
        });
        await act(async () => {});
        expect(calls('delete-status')).toHaveLength(1);
        expectNotDeleted(renderer);

        // A 200 status of in_progress is re-polled at the default pace.
        await act(async () => {
          jest.advanceTimersByTime(3_000);
        });
        await act(async () => {});
        expect(calls('delete-status')).toHaveLength(2);
        expectDeletedOnce(renderer);
        expect(calls('delete-confirm')).toHaveLength(1);
      } finally {
        act(() => renderer.unmount());
      }
    },
  );

  it('A5b a 202 in-progress answer naming ANOTHER operation is not trusted: unknown outcome, no re-arm, completion only from the status receipt', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () =>
        reply('delete-confirm', inProgressPayload(77), 202, {
          headers: { 'retry-after': '3' },
        }),
      'delete-status': () => reply('delete-status', statusPayload('completed')),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expectNotDeleted(renderer);
      expectUnknownOutcome(renderer);
      expect(allText(renderer)).not.toContain('Deletion in progress');
      expect(journalRows()).toMatchObject([
        { operation_id: deletionId(10), phase: 'confirm_pending' },
      ]);

      await pressWhenArmed(renderer, 'Retry deletion');
      expect(bodyOf(calls('delete-status')[0]!)).toEqual({
        operationId: deletionId(10),
      });
      expect(calls('delete-confirm')).toHaveLength(1);
      expectDeletedOnce(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A6 a 503 answering the confirmation is unknown (the server may have started); the status says in_progress, then completes — one confirmation, no re-arm, no "nothing deleted"', async () => {
    let statusAttempts = 0;
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () =>
        reply(
          'delete-confirm',
          {
            error: { message: 'Account deletion is temporarily unavailable.' },
          },
          503,
        ),
      'delete-status': () => {
        statusAttempts += 1;
        return reply(
          'delete-status',
          statusPayload(statusAttempts === 1 ? 'in_progress' : 'completed'),
        );
      },
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expectNotDeleted(renderer);
      expectUnknownOutcome(renderer);
      expect(allText(renderer)).not.toContain('Nothing has been deleted');

      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-status')).toHaveLength(1);
      expect(allText(renderer)).toContain('Deletion in progress');
      expect(allText(renderer)).not.toContain('Delete your account?');
      expect(buttonLabels(renderer)).toEqual(['Close']);
      expectNotDeleted(renderer);

      await act(async () => {
        jest.advanceTimersByTime(3_000);
      });
      await act(async () => {});
      expect(calls('delete-status')).toHaveLength(2);
      expect(calls('delete-confirm')).toHaveLength(1);
      expectDeletedOnce(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A7 the exit survey the player answered rides the retried request after a relaunch, not an empty body', async () => {
    let requestAttempts = 0;
    route({
      'delete-request': () => {
        requestAttempts += 1;
        return requestAttempts === 1
          ? Promise.reject(new TypeError('Network lost'))
          : reply('delete-request', requestPayload());
      },
    });
    const survey = {
      reason: 'too_expensive',
      wanted: 'price',
      details: null,
      platform: 'ios',
      appVersion: '1.0',
    };
    const first = renderScreen();
    await press(first, pressable(first, 'Delete account')[0]!);
    await press(first, pressable(first, "It's too expensive")[0]!);
    await press(first, sheetButton(first, 'Next'));
    await press(first, pressable(first, 'A lower price or a free tier')[0]!);
    await press(first, sheetButton(first, 'Continue'));
    await press(first, sheetButton(first, 'Continue to delete'));
    expect(bodyOf(calls('delete-request')[0]!)).toEqual({ survey });
    expect(journalRows()).toMatchObject([{ phase: 'request_unknown' }]);
    act(() => first.unmount());

    const second = renderScreen();
    try {
      await openDeleteSheet(second);
      expect(allText(second)).not.toContain("What's making you leave?");
      await pressWhenArmed(second, 'Retry request');
      expect(calls('delete-request')).toHaveLength(2);
      expect(journalRows()).toMatchObject([{ phase: 'ready' }]);
      expect(bodyOf(calls('delete-request')[1]!)).toEqual({ survey });
    } finally {
      act(() => second.unmount());
    }
  });

  it('A8 fallback (journal unavailable): a 202 in-progress confirmation is never rendered as deleted; the retry re-sends the same operation and completes once', async () => {
    mockDatabaseUnavailable = true;
    let confirmAttempts = 0;
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => {
        confirmAttempts += 1;
        return confirmAttempts === 1
          ? reply('delete-confirm', inProgressPayload(), 202, {
              headers: { 'retry-after': '3' },
            })
          : reply('delete-confirm', completionPayload());
      },
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expectNotDeleted(renderer);
      expectUnknownOutcome(renderer);
      expect(allText(renderer)).not.toContain('Nothing has been deleted');

      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-request')).toHaveLength(1);
      expect(calls('delete-confirm')).toHaveLength(2);
      expect(calls('delete-confirm').map(bodyOf)).toEqual([
        { challenge: deletionId(11), operationId: deletionId(10) },
        { challenge: deletionId(11), operationId: deletionId(10) },
      ]);
      expectDeletedOnce(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A9 two presses of "Retry deletion" in one frame issue one status call and complete once', async () => {
    const statusReply = deferred<Response>();
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      'delete-status': () => statusReply.promise,
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expectUnknownOutcome(renderer);
      const paced = countdownOf(renderer, 'Retry deletion');
      await act(async () => {
        jest.advanceTimersByTime(paced * 1000);
      });
      const retry = sheetButton(renderer, 'Retry deletion');
      expect(retry.props.disabled).toBe(false);
      await act(async () => {
        retry.props.onPress();
        retry.props.onPress();
      });
      expect(calls('delete-status')).toHaveLength(1);
      expect(allText(renderer)).toContain('Checking');
      await act(async () => {
        statusReply.resolve(reply('delete-status', statusPayload('completed')));
      });
      await act(async () => {});
      expect(calls('delete-status')).toHaveLength(1);
      expect(calls('delete-confirm')).toHaveLength(1);
      expectDeletedOnce(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });
});
