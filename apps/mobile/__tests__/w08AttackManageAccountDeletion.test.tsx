import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * W08-01 adversarial attacks against candidate f8ce1d44 (ManageAccount
 * deletion on the durable operation + the two-call fallback).
 *
 * Every test drives the real ManageAccountScreen against a real SQLite
 * journal, the in-memory Keychain mock and a routed `globalThis.fetch`,
 * exactly like the candidate's own suite. Each `it` is one attack; a
 * failing assertion is a confirmed break, a passing one is an attack the
 * candidate survived. Candidate tests and production code are untouched.
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
const OWNER_B = '22222222-2222-4222-8222-222222222222';
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

function statusPayload(state: string) {
  return {
    state,
    completionReceipt: state === 'completed' ? { completedAt: iso(0) } : null,
    appleAuthorizationRevocation: state === 'completed' ? 'revoked' : null,
  };
}

/** The Edge API's 409 for a request while a confirmation is in progress
 * (supabase/functions/api/index.ts requestAccountDeletion). */
function deletionInProgressError() {
  return {
    error: {
      code: 'account.deletion_in_progress',
      message:
        'Account deletion is already confirmed. Check its status before starting again.',
    },
  };
}

/** The Edge API's 401 once the bearer no longer authenticates (the account
 * behind it is gone, or the session was fenced by the confirmation). */
function sessionInvalidError() {
  return {
    error: { message: 'The session is no longer valid. Sign in again.' },
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

function bodyOf(init: RequestInit): unknown {
  return JSON.parse(String(init.body));
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

/** Same contract the candidate's own suite pins for an unknown outcome. */
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

/** The screen must not claim nothing was deleted while the server says a
 * confirmation for this account is already being carried out. */
function expectNoNothingDeletedClaim(renderer: TestRenderer.ReactTestRenderer) {
  const text = allText(renderer);
  expect(text).not.toContain('Nothing was deleted');
  expect(text).not.toContain('Nothing has been deleted');
  expect(text).not.toContain('Keep my account');
  expect(text).not.toContain('Delete your account?');
}

describe('W08-01 attacks against candidate f8ce1d44', () => {
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

  // A1 — replay / duplicate identity: the server already holds a confirmed,
  // in-progress deletion for this account (another device, or this device
  // after its journal was lost). delete-request answers 409
  // account.deletion_in_progress.
  it('A1 durable: a 409 deletion_in_progress on delete-request is not rendered as "Nothing has been deleted"', async () => {
    route({
      'delete-request': () =>
        reply('delete-request', deletionInProgressError(), 409),
    });
    const renderer = renderScreen();
    try {
      await openReview(renderer);
      await press(renderer, sheetButton(renderer, 'Continue to delete'));
      expectNotDeleted(renderer);
      expect(calls('delete-request')).toHaveLength(1);
      expectNoNothingDeletedClaim(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A1 fallback: a 409 deletion_in_progress on delete-request is not rendered as "Delete your account?" / "Keep my account"', async () => {
    mockDatabaseUnavailable = true;
    route({
      'delete-request': () =>
        reply('delete-request', deletionInProgressError(), 409),
    });
    const renderer = renderScreen();
    try {
      await openReview(renderer);
      await press(renderer, sheetButton(renderer, 'Continue to delete'));
      expectNotDeleted(renderer);
      expect(calls('delete-request')).toHaveLength(1);
      expectNoNothingDeletedClaim(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  // A2 — network failure at the confirm step on the fallback path: the
  // confirmation reply is lost, the account was actually deleted, and the
  // retry (same challenge) is answered 401 because the bearer is dead.
  it('A2 fallback: a 401 on the retry of a lost confirmation stays UNKNOWN (never "Keep my account")', async () => {
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
      expectNotDeleted(renderer);
      expectUnknownOutcome(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  // A3 — crash-between-steps analogue: getDb() retries the open on every
  // call, so the database can be unavailable for one step and available for
  // the next. The flow is chosen per step, not per attempt.
  it('A3a: a request minted while the database was down is still confirmed once the database is back', async () => {
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
      // A confirmation the user pressed must go out exactly once; a screen
      // that sent nothing must not report an unknown outcome.
      const text = allText(renderer);
      if (calls('delete-confirm').length === 0) {
        expect(text).not.toContain('may have completed');
      }
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(bodyOf(calls('delete-confirm')[0]!)).toEqual({
        challenge: deletionId(11),
        operationId: deletionId(10),
      });
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A3b: a durable request whose confirm step finds the database down does not fabricate an unknown outcome without sending anything', async () => {
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
      const text = allText(renderer);
      if (calls('delete-confirm').length === 0) {
        expect(text).not.toContain('may have completed');
      }
      expect(calls('delete-confirm')).toHaveLength(1);
    } finally {
      act(() => renderer.unmount());
    }
  });

  // A4 — far-future clock / process death: a lost confirmation whose status
  // window (24h) has lapsed before the app is opened again.
  it('A4 durable: an unresolved confirmation is still reported after the status window lapsed — not a fresh survey', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
    });
    const first = renderScreen();
    await armDeletion(first);
    await press(first, sheetButton(first, 'Permanently delete'));
    expect(allText(first)).toContain('Deletion status unknown');
    expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
    act(() => first.unmount());

    jest.setSystemTime(Date.now() + 25 * HOUR_MS);
    const second = renderScreen();
    try {
      await press(second, pressable(second, 'Delete account')[0]!);
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      expectNotDeleted(second);
      expect(allText(second)).not.toContain("What's making you leave?");
      expect(allText(second)).toContain('Deletion status unknown');
    } finally {
      act(() => second.unmount());
    }
  });

  // A5 — corrupt/partial persisted state: one row from another account with
  // a document version this build does not understand.
  it("A5 durable: a foreign unsupported journal row does not hide this owner's unresolved confirmation", async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
    });
    const first = renderScreen();
    await armDeletion(first);
    await press(first, sheetButton(first, 'Permanently delete'));
    expect(allText(first)).toContain('Deletion status unknown');
    act(() => first.unmount());

    const foreignJob = deletionId(90);
    mockDatabase.native
      .prepare(
        'INSERT INTO device_account_deletion_journal (job_id, owner_id, api_origin, operation_id, revision, phase, document) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        foreignJob,
        OWNER_B,
        ORIGIN,
        null,
        0,
        'request_pending',
        JSON.stringify({ version: 2, jobId: foreignJob, ownerId: OWNER_B }),
      );

    const second = renderScreen();
    try {
      await press(second, pressable(second, 'Delete account')[0]!);
      expectNotDeleted(second);
      expect(allText(second)).not.toContain("What's making you leave?");
      expect(allText(second)).toContain('Deletion status unknown');
      expect(
        journalRows().filter(row => row.owner_id === OWNER_A),
      ).toHaveLength(1);
    } finally {
      act(() => second.unmount());
    }
  });

  // A6 — 429 + Retry-After at the confirm step, maximum honoured value.
  it('A6 durable: a 429 with Retry-After 86400 on confirm stays unknown, deletes nothing, mints nothing, and keeps Close available', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () =>
        reply(
          'delete-confirm',
          {
            error: {
              code: 'account.deletion_too_fast',
              message: 'Please review the confirmation before deleting.',
            },
          },
          429,
          { headers: { 'retry-after': '86400' } },
        ),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expectNotDeleted(renderer);
      expectUnknownOutcome(renderer);
      expect(calls('delete-request')).toHaveLength(1);
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      const retry = sheetButton(renderer, 'Retry deletion');
      expect(retry.props.disabled).toBe(true);
      expect(String(retry.props.label)).toBe('Retry deletion (86400)');
    } finally {
      act(() => renderer.unmount());
    }
  });

  // A7 — redirect at the status step carrying a "completed" receipt.
  it('A7 durable: a redirected delete-status reply with a completed receipt is never rendered as deleted', async () => {
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
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-status')).toHaveLength(1);
      expectNotDeleted(renderer);
      expectUnknownOutcome(renderer);
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  // A8 — boundary: a status that says completed but carries no receipt.
  it('A8 durable: a "completed" status without a receipt never completes the deletion', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      'delete-status': () =>
        reply('delete-status', {
          state: 'completed',
          completionReceipt: null,
          appleAuthorizationRevocation: null,
        }),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-status')).toHaveLength(1);
      expectNotDeleted(renderer);
      expectUnknownOutcome(renderer);
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  // A9 — clock rollback between arming and confirming.
  it('A9 durable: a clock rolled back after arming sends no confirmation, deletes nothing and keeps the outcome honest', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => reply('delete-confirm', completionPayload()),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      jest.setSystemTime(Date.now() - HOUR_MS);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expectNotDeleted(renderer);
      expect(allText(renderer)).not.toContain('Deletion status unknown');
      expect(allText(renderer)).not.toContain('Account deleted');
      if (calls('delete-confirm').length === 1) {
        expect(
          useAuthStore.getState().completeAccountDeletion,
        ).toHaveBeenCalledTimes(1);
      } else {
        expect(calls('delete-confirm')).toHaveLength(0);
        expect(journalRows()).toMatchObject([{ phase: 'ready' }]);
      }
    } finally {
      act(() => renderer.unmount());
    }
  });

  // A10 — reentrancy: two presses of "Retry deletion" in one frame.
  it('A10 durable: two presses of "Retry deletion" in one frame are one status call and one completion', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      'delete-status': () => reply('delete-status', statusPayload('completed')),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      const paced = /\((\d+)\)$/.exec(
        String(sheetButton(renderer, 'Retry deletion').props.label),
      );
      if (paced) {
        await act(async () => {
          jest.advanceTimersByTime(Number(paced[1]) * 1000);
        });
      }
      const retry = sheetButton(renderer, 'Retry deletion');
      expect(retry.props.disabled).toBe(false);
      await act(async () => {
        retry.props.onPress();
        retry.props.onPress();
      });
      expect(calls('delete-status')).toHaveLength(1);
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  // A11 — boundary values on the step-1 wire: expiry not after the
  // challenge expiry, and a NaN expiry.
  it('A11 durable: a step-1 reply with an out-of-order or NaN expiry arms nothing and deletes nothing', async () => {
    let attempt = 0;
    route({
      'delete-request': () => {
        attempt += 1;
        return reply(
          'delete-request',
          attempt === 1
            ? { ...requestPayload(), statusExpiresAt: iso(900_000) }
            : { ...requestPayload(), expiresAt: 'not-a-date' },
        );
      },
    });
    const renderer = renderScreen();
    try {
      await openReview(renderer);
      await press(renderer, sheetButton(renderer, 'Continue to delete'));
      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
      expectNotDeleted(renderer);
      expect(allText(renderer)).not.toContain('Deletion status unknown');

      await press(renderer, sheetButton(renderer, 'Retry request'));
      expect(calls('delete-request')).toHaveLength(2);
      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
      expectNotDeleted(renderer);
      expect(journalRows()).toMatchObject([
        { operation_id: null, phase: 'request_unknown' },
      ]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  // A12 — copy policy (APP_STORE_SUBMISSION.md §rules: never mention Google
  // Play in user-facing copy) on the completion notice this path shows.
  it('A12 copy: the "Account deleted" notice shown by the shipping path names no other store', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => reply('delete-confirm', completionPayload()),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
      const notice = JSON.stringify(mockShowBrandNotice.mock.calls[0]![0]);
      expect(notice).toContain('Account deleted');
      expect(notice).not.toMatch(/Google Play|Android/);
      expect(buttonLabels(renderer)).not.toContain('Permanently delete');
    } finally {
      act(() => renderer.unmount());
    }
  });
});
