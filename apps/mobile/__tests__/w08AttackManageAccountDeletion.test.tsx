import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * W08-01 adversarial attacks against candidate 1fbdd4a0 (ManageAccount on
 * the durable deletion operation). Each `it` is one attack at a failure
 * boundary the candidate's own suite does not pin. Attacks that hold are
 * regression pins; attacks that fail are reported breaks.
 *
 * Nothing here touches production code or the candidate's tests; the
 * harness mirrors w08ManageAccountDeletion.test.tsx so the only seams are
 * the ones production uses (real screen, real SQLite journal, in-memory
 * Keychain mock, routed `globalThis.fetch`).
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
import { createDeletionOperationJournal } from '../src/account/deletionOperationJournal';
import { parseDeletionOwnership } from '../src/account/deletionOperationContracts';
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

const UNKNOWN_TITLE = 'Deletion status unknown';
const IN_PROGRESS_TITLE = 'Deletion in progress';
const SURVEY_TITLE = "What's making you leave?";
const REVIEW_TITLE = 'Delete your account?';
const NOTHING_HAS_BEEN_DELETED = 'Nothing has been deleted';
const NOTHING_WAS_DELETED = 'Nothing was deleted';

/** APP_STORE_SUBMISSION.md — never in user-facing copy. */
const BANNED_COPY =
  /Android|Google Play|guest mode|Live Court|DUPR|SwingVision|PB Vision|Selkirk|JOOLA|\d+\s?% accura/i;

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

function inProgressPayload(operation = 10) {
  return { operationId: deletionId(operation), state: 'in_progress' };
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

function sessionInvalidError() {
  return {
    error: { message: 'The session is no longer valid. Sign in again.' },
  };
}

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

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string>)[name];
}

function journalRows() {
  return mockDatabase.native
    .prepare(
      'SELECT job_id, owner_id, operation_id, phase, document FROM device_account_deletion_journal ORDER BY rowid',
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

async function openReviewWithSurvey(renderer: TestRenderer.ReactTestRenderer) {
  await press(renderer, pressable(renderer, 'Delete account')[0]!);
  await press(renderer, pressable(renderer, "It's too expensive")[0]!);
  await press(renderer, sheetButton(renderer, 'Next'));
  await press(
    renderer,
    pressable(renderer, 'A lower price or a free tier')[0]!,
  );
  await press(renderer, sheetButton(renderer, 'Continue'));
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
  expect(allText(renderer)).not.toContain(UNKNOWN_TITLE);
}

function expectNotDeleted(renderer: TestRenderer.ReactTestRenderer) {
  expect(
    useAuthStore.getState().completeAccountDeletion,
  ).not.toHaveBeenCalled();
  expect(mockShowBrandNotice).not.toHaveBeenCalled();
  expect(allText(renderer)).not.toContain('Account deleted');
}

/** No claim that the account is present, no fresh request offered. */
function expectNoPresenceClaim(renderer: TestRenderer.ReactTestRenderer) {
  const text = allText(renderer);
  expect(text).not.toContain(NOTHING_HAS_BEEN_DELETED);
  expect(text).not.toContain(NOTHING_WAS_DELETED);
  expect(text).not.toContain(REVIEW_TITLE);
  expect(text).not.toContain(SURVEY_TITLE);
  expect(text).not.toContain('Keep my account');
  expect(sheetButtons(renderer, 'Retry request')).toHaveLength(0);
  expect(sheetButtons(renderer, 'Continue to delete')).toHaveLength(0);
  expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
}

/** Owner A's request is refused with 409 account.deletion_in_progress. */
async function refusedAsInProgress(withSurvey = false) {
  const renderer = renderScreen();
  try {
    if (withSurvey) await openReviewWithSurvey(renderer);
    else await openReview(renderer);
    await press(renderer, sheetButton(renderer, 'Continue to delete'));
    expect(allText(renderer)).toContain(IN_PROGRESS_TITLE);
    expect(buttonLabels(renderer)).toEqual(['Close']);
    expect(journalRows()).toMatchObject([
      { owner_id: OWNER_A, operation_id: null, phase: 'request_unknown' },
    ]);
  } finally {
    act(() => renderer.unmount());
  }
}

/** Owner A sends a confirmation whose reply never arrives. */
async function loseConfirmation() {
  const renderer = renderScreen();
  try {
    await armDeletion(renderer);
    await press(renderer, sheetButton(renderer, 'Permanently delete'));
    expect(calls('delete-confirm')).toHaveLength(1);
    expect(allText(renderer)).toContain(UNKNOWN_TITLE);
    expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
  } finally {
    act(() => renderer.unmount());
  }
}

describe('W08-01 adversarial attacks on ManageAccount durable deletion', () => {
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

  /**
   * ATTACK 1 — a 409 deletion_in_progress is a SERVER FACT: a confirmed
   * deletion of this account is being carried out. The candidate re-asks on
   * a later launch; when that re-ask fails (dead bearer, 5xx, timeout, 429)
   * the row's `lastIssue` is overwritten and the sheet must not turn the
   * known-in-progress deletion into "Nothing has been deleted" + a fresh
   * "Retry request".
   */
  describe('ATTACK 1: a failed re-ask after 409 deletion_in_progress', () => {
    const failures: ReadonlyArray<[string, Route]> = [
      [
        '401 (the bearer died — the deletion most likely completed)',
        () => reply('delete-request', sessionInvalidError(), 401),
      ],
      [
        '503 (server unavailable)',
        () => reply('delete-request', { error: { message: 'busy' } }, 503),
      ],
      [
        'network loss',
        () => Promise.reject(new TypeError('Network request failed')),
      ],
      [
        '429 with Retry-After',
        () =>
          reply('delete-request', { error: { message: 'slow down' } }, 429, {
            headers: { 'retry-after': '30' },
          }),
      ],
    ];

    it.each(failures)(
      'a re-ask answered %s never claims nothing has been deleted and never offers another request',
      async (_label, failure) => {
        let requests = 0;
        route({
          'delete-request': init => {
            requests += 1;
            return requests === 1
              ? reply('delete-request', deletionInProgressError(), 409)
              : failure(init);
          },
        });
        await refusedAsInProgress();

        await advance(8 * DAY_MS);
        const reopened = renderScreen();
        try {
          await openDeleteSheet(reopened);
          expect(calls('delete-request')).toHaveLength(2);
          expectNotDeleted(reopened);
          expectNoPresenceClaim(reopened);
          expect(allText(reopened)).toMatch(
            new RegExp(`${IN_PROGRESS_TITLE}|${UNKNOWN_TITLE}`),
          );
        } finally {
          act(() => reopened.unmount());
        }
      },
    );
  });

  /**
   * ATTACK 2 — the exit survey rides on step 1 (edge fn records it only
   * after the challenge is minted, so a 409 drops it server-side). The
   * automatic re-ask on a later launch must carry the survey the owner
   * typed, otherwise the answer is silently lost.
   */
  it('ATTACK 2: the re-ask after a 409 carries the exit survey the owner gave', async () => {
    let requests = 0;
    route({
      'delete-request': () => {
        requests += 1;
        return requests === 1
          ? reply('delete-request', deletionInProgressError(), 409)
          : reply('delete-request', requestPayload(20));
      },
    });
    await refusedAsInProgress(true);
    expect(bodyOf(calls('delete-request')[0]!)).toMatchObject({
      survey: { reason: 'too_expensive', wanted: 'price' },
    });

    await advance(8 * DAY_MS);
    const reopened = renderScreen();
    try {
      await openDeleteSheet(reopened);
      expect(calls('delete-request')).toHaveLength(2);
      expect(bodyOf(calls('delete-request')[1]!)).toMatchObject({
        survey: { reason: 'too_expensive', wanted: 'price' },
      });
    } finally {
      act(() => reopened.unmount());
    }
  });

  /**
   * ATTACK 3 — copy/UX contradiction: after a lost confirmation the status
   * poll says `superseded`. The sheet's message tells the owner to "Start
   * again to continue" — so the sheet must actually offer a way to start
   * again (or not say so).
   */
  it('ATTACK 3: a superseded operation that says "Start again" offers a way to start again', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      'delete-status': () =>
        reply('delete-status', statusPayload('superseded')),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expect(allText(renderer)).toContain(UNKNOWN_TITLE);
      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-status')).toHaveLength(1);
      expectNotDeleted(renderer);
      const text = allText(renderer);
      if (text.includes('Start again')) {
        expect(sheetButtons(renderer, 'Continue to delete')).toHaveLength(1);
      }
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('ATTACK 3b: re-entry after a superseded operation offers a fresh request (the in-dialog dead end is recoverable by closing)', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      'delete-status': () =>
        reply('delete-status', statusPayload('superseded')),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-status')).toHaveLength(1);
      expect(buttonLabels(renderer)).toEqual(['Close']);
    } finally {
      act(() => renderer.unmount());
    }
    const reopened = renderScreen();
    try {
      await openDeleteSheet(reopened);
      expect(allText(reopened)).toContain(SURVEY_TITLE);
      expectNotDeleted(reopened);
    } finally {
      act(() => reopened.unmount());
    }
  });

  /**
   * ATTACK 4 — permanent lockout. A confirmation is lost, the owner does not
   * come back within the 24h status window, and the server sweeps the
   * operation after its 7-day retention. From then on the server can never
   * answer for it and nothing this device holds can change; the account is
   * (very likely) still present, yet the device never again lets the owner
   * request deletion — App Store 5.1.1(v) requires in-app deletion.
   */
  it('ATTACK 4: after the status window AND the server retention have lapsed, the owner can still request deletion from this device', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      'delete-status': () => reply('delete-status', statusPayload('pending')),
    });
    await loseConfirmation();

    for (const gap of [2 * DAY_MS, 8 * DAY_MS, 30 * DAY_MS]) {
      await advance(gap);
      const reopened = renderScreen();
      try {
        await openDeleteSheet(reopened);
        expectNotDeleted(reopened);
        expect(allText(reopened)).not.toContain(REVIEW_TITLE);
      } finally {
        act(() => reopened.unmount());
      }
    }
    // 40 days on: the server forgot the operation 33 days ago. The owner
    // must have SOME path to deletion on this device.
    const late = renderScreen();
    try {
      await openDeleteSheet(late);
      expectNotDeleted(late);
      const canStart =
        sheetButtons(late, 'Continue to delete').length > 0 ||
        sheetButtons(late, 'Retry deletion').length > 0 ||
        sheetButtons(late, 'Retry request').length > 0 ||
        allText(late).includes(SURVEY_TITLE);
      expect(canStart).toBe(true);
    } finally {
      act(() => late.unmount());
    }
  });

  /**
   * ATTACK 5 — process death between the journal write and the network:
   * the row exists at revision 0 / request_pending and nothing was sent.
   * Re-entry must retry under the SAME job, never say "unknown", and
   * complete exactly once.
   */
  it('ATTACK 5: a crash after journal.create but before the request left resumes the same job and completes once', async () => {
    const journal = createDeletionOperationJournal(mockDatabase.db);
    const ownership = parseDeletionOwnership({
      references: [],
      legacyMedia: 'unverified',
    });
    if (!ownership) throw new Error('fixture ownership must parse');
    const jobId = deletionId(77);
    await journal.create({
      version: 1,
      jobId,
      ownerId: OWNER_A,
      apiOrigin: ORIGIN,
      operationId: null,
      revision: 0,
      phase: 'request_pending',
      expiresAt: null,
      statusExpiresAt: null,
      reviewAfterMs: null,
      createdAtMs: Date.now() - 60_000,
      nextAttemptAtMs: 0,
      retryCount: 0,
      serverState: null,
      lastIssue: null,
      receipt: null,
      cleanup: { completed: [], pending: null },
      ownership,
    });
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => reply('delete-confirm', completionPayload()),
    });
    const renderer = renderScreen();
    try {
      await openDeleteSheet(renderer);
      const text = allText(renderer);
      expect(text).not.toContain(SURVEY_TITLE);
      expect(text).not.toContain(UNKNOWN_TITLE);
      expect(text).not.toContain('may have completed');
      expect(text).toContain(NOTHING_HAS_BEEN_DELETED);
      expect(calls('delete-request')).toHaveLength(0);
      expectNotDeleted(renderer);

      await pressWhenArmed(renderer, 'Retry request');
      expect(calls('delete-request')).toHaveLength(1);
      expect(journalRows()).toMatchObject([
        { job_id: jobId, operation_id: deletionId(10), phase: 'ready' },
      ]);
      await pressWhenArmed(renderer, 'Permanently delete');
      await act(async () => {});
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(journalRows()).toMatchObject([
        { job_id: jobId, phase: 'receipt_verified' },
      ]);
      expectDeleted(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  /**
   * ATTACK 6 — replayed step-1 reply: an attacker (or a buggy proxy) replays
   * an earlier 200 whose operation id is already journaled under another
   * job. The journal must not hold two rows for one operation, the sheet
   * must not arm a challenge for the replayed operation, and nothing may
   * read as deleted or "may have completed".
   */
  it('ATTACK 6: a replayed delete-request reply naming an operation already journaled never arms it twice', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload(10)),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
    });
    // First launch: request 10 is minted and its confirmation is lost.
    await loseConfirmation();
    // The status window closes... no: keep it live, but sign in as owner B
    // so B's request is answered with A's replayed operation 10.
    signIn(OWNER_B, BEARER_B, 'apple');
    const renderer = renderScreen();
    try {
      await openReview(renderer);
      await press(renderer, sheetButton(renderer, 'Continue to delete'));
      await act(async () => {});
      expect(calls('delete-request')).toHaveLength(2);
      expect(headerOf(calls('delete-request')[1]!, 'Authorization')).toBe(
        `Bearer ${BEARER_B}`,
      );
      const rows = journalRows();
      expect(
        rows.filter(row => row.operation_id === deletionId(10)),
      ).toHaveLength(1);
      expect(rows).toMatchObject([
        { owner_id: OWNER_A, operation_id: deletionId(10) },
        { owner_id: OWNER_B, operation_id: null },
      ]);
      const text = allText(renderer);
      expect(text).not.toContain(UNKNOWN_TITLE);
      expect(text).not.toContain('may have completed');
      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
      expectNotDeleted(renderer);
      // B's replayed row is never confirmable: no confirm may go out under
      // A's operation from B's session.
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(headerOf(calls('delete-confirm')[0]!, 'Authorization')).toBe(
        `Bearer ${BEARER_A}`,
      );
    } finally {
      act(() => renderer.unmount());
    }
  });

  /**
   * ATTACK 7 — Retry-After boundaries on the 202 in_progress reply: `0`
   * (not a positive delay), an HTTP-date, a negative and an oversized value
   * must all fall back to the 3s default — never a 0ms tight poll loop, and
   * never a poll that waits past the value the server actually sent.
   */
  it.each([['0'], ['Wed, 21 Oct 2015 07:28:00 GMT'], ['-5'], ['999999']])(
    'ATTACK 7: a 202 in_progress with Retry-After %p polls once after 3s, not before and not in a loop',
    async retryAfter => {
      let statuses = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply('delete-confirm', inProgressPayload(), 202, {
            headers: { 'retry-after': retryAfter },
          }),
        'delete-status': () => {
          statuses += 1;
          return reply(
            'delete-status',
            statusPayload(statuses >= 3 ? 'completed' : 'in_progress'),
          );
        },
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(allText(renderer)).toContain(IN_PROGRESS_TITLE);
        expect(calls('delete-status')).toHaveLength(0);
        await advance(2_999);
        expect(calls('delete-status')).toHaveLength(0);
        await advance(1);
        expect(calls('delete-status')).toHaveLength(1);
        // Each further poll is paced by the server's status cadence (3s).
        await advance(2_999);
        expect(calls('delete-status')).toHaveLength(1);
        await advance(1);
        expect(calls('delete-status')).toHaveLength(2);
        await advance(3_000);
        expect(calls('delete-status')).toHaveLength(3);
        expectDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    },
  );

  /**
   * ATTACK 8 — interleaved account switch while OBSERVING: the poll timer
   * fires after owner B signed in. Nothing may go out under B, the outcome
   * stays unknown/in progress, and when A returns the SAME operation
   * completes from its status capability.
   */
  it('ATTACK 8: a poll timer that fires after an account switch sends nothing under the replacement; the original owner resumes and completes', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => reply('delete-confirm', inProgressPayload(), 202),
      'delete-status': () => reply('delete-status', statusPayload('completed')),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expect(allText(renderer)).toContain(IN_PROGRESS_TITLE);
      await act(async () => {
        signIn(OWNER_B, BEARER_B, 'google');
      });
      await advance(3_000);
      expect(calls('delete-status')).toHaveLength(0);
      expectNotDeleted(renderer);
      const text = allText(renderer);
      expect(text).not.toContain(REVIEW_TITLE);
      expect(text).not.toContain(NOTHING_WAS_DELETED);
      expect(text).not.toContain(NOTHING_HAS_BEEN_DELETED);
      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
      // Pressing whatever retry the sheet offers still sends nothing under B.
      for (const retry of sheetButtons(renderer, 'Retry deletion')) {
        if (retry.props.disabled !== true) await press(renderer, retry);
      }
      await advance(10_000);
      expect(calls('delete-status')).toHaveLength(0);
      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, operation_id: deletionId(10) },
      ]);
    } finally {
      act(() => renderer.unmount());
    }

    signIn(OWNER_A, BEARER_A, 'google');
    const back = renderScreen();
    try {
      await openDeleteSheet(back);
      await advance(3_000);
      expect(calls('delete-request')).toHaveLength(1);
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(calls('delete-status')).toHaveLength(1);
      expect(headerOf(calls('delete-status')[0]!, 'Authorization')).toBe(
        `Bearer ${DELETION_CAPABILITY}`,
      );
      expectDeleted(back);
    } finally {
      act(() => back.unmount());
    }
  });

  /**
   * ATTACK 9 — reentrancy on "Retry deletion": two presses in one tick, and
   * a press while the previous check is still in flight, send exactly one
   * status request and complete exactly once.
   */
  it('ATTACK 9: a double-tapped "Retry deletion" and a tap during the in-flight check send one status call and complete once', async () => {
    const status = deferred<Response>();
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      'delete-status': () => status.promise,
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      const paced = /\((\d+)\)$/.exec(
        String(sheetButton(renderer, 'Retry deletion').props.label),
      );
      if (paced) await advance(Number(paced[1]) * 1000);
      const retry = sheetButton(renderer, 'Retry deletion');
      expect(retry.props.disabled).toBe(false);
      await act(async () => {
        retry.props.onPress();
        retry.props.onPress();
      });
      expect(calls('delete-status')).toHaveLength(1);
      for (const button of sheetButtons(renderer, 'Retry deletion').concat(
        sheetButtons(renderer, 'Checking'),
      )) {
        if (button.props.disabled !== true) await press(renderer, button);
      }
      expect(calls('delete-status')).toHaveLength(1);
      await act(async () => {
        status.resolve(reply('delete-status', statusPayload('completed')));
      });
      await act(async () => {});
      expect(calls('delete-status')).toHaveLength(1);
      expectDeleted(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  /**
   * ATTACK 10 — clock rollback between the request and the confirmation:
   * the device clock jumps back an hour while the challenge is armed. The
   * press must send nothing under a clock the foundation refuses, must not
   * become "unknown", and once the clock is corrected the SAME live
   * challenge must be confirmable before it expires.
   */
  it('ATTACK 10: a clock rolled back while armed sends nothing and never reads as unknown; once corrected, the live challenge confirms', async () => {
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
      const trueNow = Date.now();
      jest.setSystemTime(trueNow - HOUR_MS);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      await act(async () => {});
      expect(calls('delete-confirm')).toHaveLength(0);
      expectNotDeleted(renderer);
      const text = allText(renderer);
      expect(text).not.toContain(UNKNOWN_TITLE);
      expect(text).not.toContain('may have completed');
      expect(text).not.toContain(SURVEY_TITLE);
      expect(journalRows()).toMatchObject([
        { operation_id: deletionId(10), phase: 'ready' },
      ]);
      // The challenge is still the one on screen; it is paced, not lost.
      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);

      // The clock is corrected 10s later. The challenge (15 min) is still
      // live and its review window passed long ago, so the owner must be
      // able to confirm it now — a stale hour-long countdown would outlive
      // the challenge and force a new request for nothing.
      jest.setSystemTime(trueNow + 10_000);
      await advance(10_000);
      const armed = sheetButton(renderer, 'Permanently delete');
      expect(armed.props.label).toBe('Permanently delete');
      expect(armed.props.disabled).toBe(false);
      await press(renderer, armed);
      await act(async () => {});
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(bodyOf(calls('delete-confirm')[0]!)).toEqual({
        challenge: deletionId(11),
        operationId: deletionId(10),
      });
      expectDeleted(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('ATTACK 10b: re-entry after a clock rollback re-arms the SAME live challenge from the corrected clock and confirms once', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => reply('delete-confirm', completionPayload()),
    });
    const trueNow = Date.now() + 5_000;
    const first = renderScreen();
    try {
      await armDeletion(first);
      jest.setSystemTime(trueNow - HOUR_MS);
      await press(first, sheetButton(first, 'Permanently delete'));
      await act(async () => {});
      expect(calls('delete-confirm')).toHaveLength(0);
      expectNotDeleted(first);
    } finally {
      act(() => first.unmount());
    }
    jest.setSystemTime(trueNow + 10_000);
    const second = renderScreen();
    try {
      await openDeleteSheet(second);
      expect(calls('delete-request')).toHaveLength(1);
      expect(allText(second)).not.toContain(SURVEY_TITLE);
      await pressWhenArmed(second, 'Permanently delete');
      await act(async () => {});
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(bodyOf(calls('delete-confirm')[0]!)).toEqual({
        challenge: deletionId(11),
        operationId: deletionId(10),
      });
      expectDeleted(second);
    } finally {
      act(() => second.unmount());
    }
  });

  /**
   * ATTACK 11 — copy audit across every state the sheet can render: none may
   * carry banned store copy, and every disabled action must announce itself
   * disabled to assistive tech.
   */
  it('ATTACK 11: every rendered deletion state is free of banned copy and exposes disabled state to accessibility', async () => {
    let requests = 0;
    route({
      'delete-request': () => {
        requests += 1;
        return requests === 1
          ? reply('delete-request', deletionInProgressError(), 409, {
              headers: { 'retry-after': '600' },
            })
          : reply('delete-request', requestPayload());
      },
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      'delete-status': () =>
        reply('delete-status', { error: { message: 'slow' } }, 429, {
          headers: { 'retry-after': '120' },
        }),
    });
    const audit = (renderer: TestRenderer.ReactTestRenderer) => {
      const text = allText(renderer);
      expect(text).not.toMatch(BANNED_COPY);
      for (const button of renderer.root.findAllByType(Button)) {
        if (button.props.disabled) {
          const pressables = button.findAll(
            node => node.props.accessibilityState !== undefined,
          );
          expect(pressables.length).toBeGreaterThan(0);
          expect(pressables[0]!.props.accessibilityState).toMatchObject({
            disabled: true,
          });
        }
      }
    };
    const first = renderScreen();
    try {
      audit(first);
      await press(first, pressable(first, 'Delete account')[0]!);
      audit(first);
      await press(first, pressable(first, 'Skip the survey')[0]!);
      audit(first);
      await press(first, sheetButton(first, 'Continue to delete'));
      audit(first); // already_in_progress
    } finally {
      act(() => first.unmount());
    }
    await advance(11 * 60_000);
    const second = renderScreen();
    try {
      await openDeleteSheet(second);
      audit(second); // armed with countdown
      await pressWhenArmed(second, 'Permanently delete');
      audit(second); // confirm_unknown
      await pressWhenArmed(second, 'Retry deletion');
      audit(second); // confirm_unknown paced by Retry-After
      expect(sheetButton(second, 'Retry deletion').props.disabled).toBe(true);
      expectNotDeleted(second);
    } finally {
      act(() => second.unmount());
    }
  });
});
