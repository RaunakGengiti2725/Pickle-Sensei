import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * W08-01 adversarial attacks against candidate 8c6088a0 (branch
 * devin/pp/w08-01/impl-r8). Each test is an attack at a failure boundary of
 * the shipping ManageAccount deletion path: the real screen, the real SQLite
 * journal, the in-memory Keychain mock and a routed `globalThis.fetch`.
 *
 * A failing test here is a confirmed break of the candidate; a passing test
 * is an attack the candidate withstood. Neither production code nor the
 * candidate's own tests are touched.
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

const configuredOrigin = getRuntimePublicConfig().apiBaseUrl;
if (!configuredOrigin)
  throw new Error('runtime config must expose the API origin');
const ORIGIN: string = configuredOrigin;

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const BEARER_A = 'session.bearer.owner-a';

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

function journalRows() {
  return mockDatabase.native
    .prepare(
      'SELECT owner_id, operation_id, phase, document FROM device_account_deletion_journal ORDER BY rowid',
    )
    .all();
}

function journalDocument(row: unknown): Record<string, unknown> {
  const { document } = row as { document: string };
  return JSON.parse(document) as Record<string, unknown>;
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

function expectNotDeleted(renderer: TestRenderer.ReactTestRenderer) {
  expect(
    useAuthStore.getState().completeAccountDeletion,
  ).not.toHaveBeenCalled();
  expect(mockShowBrandNotice).not.toHaveBeenCalled();
  expect(allText(renderer)).not.toContain('Account deleted');
}

/** The server's last definite word about this account was "a confirmed
 * deletion is being carried out" (409 account.deletion_in_progress). Until
 * a later reply says otherwise, the sheet may neither claim nothing was
 * deleted nor offer to keep the account. */
function expectNoNothingDeletedClaim(renderer: TestRenderer.ReactTestRenderer) {
  const text = allText(renderer);
  expect(text).not.toContain('Nothing was deleted');
  expect(text).not.toContain('Nothing has been deleted');
  expect(text).not.toContain('Keep my account');
  expect(text).not.toContain('Delete your account?');
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

function blockedError() {
  return {
    error: {
      code: 'account.deletion_blocked',
      message: 'This account cannot be deleted right now.',
    },
  };
}

function tooFastError() {
  return {
    error: {
      code: 'account.deletion_too_fast',
      message: 'Review the confirmation before deleting your account.',
    },
  };
}

function rateLimitedError() {
  return {
    error: { code: 'rate_limited', message: 'Too many requests.' },
  };
}

describe('W08-01 attacks on candidate 8c6088a0', () => {
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

  /** Mints a request the server refuses with 409 deletion_in_progress. */
  async function refusedAsInProgress() {
    const renderer = renderScreen();
    try {
      await openReview(renderer);
      await press(renderer, sheetButton(renderer, 'Continue to delete'));
      expect(allText(renderer)).toContain('Deletion in progress');
      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, operation_id: null, phase: 'request_unknown' },
      ]);
    } finally {
      act(() => renderer.unmount());
    }
    return journalDocument(journalRows()[0]!).jobId;
  }

  describe('ATTACK 1 — network failure on the re-ask of a stale 409 refusal', () => {
    /**
     * resume() re-asks a stale 409 deletion_in_progress refusal under the
     * same job. The server's last definite word was "a confirmed deletion is
     * being carried out". If the re-ask itself fails, the candidate rewrites
     * the row's lastIssue and renders the plain request_unknown copy —
     * "Nothing has been deleted" / "Keep my account" — although the server
     * never unsaid the in-progress deletion.
     */
    it('a 401 answering the re-ask (the account is gone) must not render "Nothing has been deleted"', async () => {
      let requests = 0;
      route({
        'delete-request': () => {
          requests += 1;
          return requests === 1
            ? reply('delete-request', deletionInProgressError(), 409)
            : reply('delete-request', sessionInvalidError(), 401);
        },
      });
      const jobId = await refusedAsInProgress();

      await advance(8 * 86_400_000);
      const later = renderScreen();
      try {
        await openDeleteSheet(later);
        expect(calls('delete-request')).toHaveLength(2);
        expect(journalDocument(journalRows()[0]!).jobId).toBe(jobId);
        expectNotDeleted(later);
        expectNoNothingDeletedClaim(later);
      } finally {
        act(() => later.unmount());
      }
    });

    it('a re-ask lost to the network must not render "Nothing has been deleted" over the server\'s last "in progress"', async () => {
      let requests = 0;
      route({
        'delete-request': () => {
          requests += 1;
          return requests === 1
            ? reply('delete-request', deletionInProgressError(), 409)
            : Promise.reject(new TypeError('Network request failed'));
        },
      });
      await refusedAsInProgress();

      await advance(8 * 86_400_000);
      const later = renderScreen();
      try {
        await openDeleteSheet(later);
        expect(calls('delete-request')).toHaveLength(2);
        expectNotDeleted(later);
        expectNoNothingDeletedClaim(later);
      } finally {
        act(() => later.unmount());
      }
    });
  });

  describe('ATTACK 2 — clock rollback during the 5 s arming countdown', () => {
    /**
     * The countdown that enables "Permanently delete" is an interval, but
     * the foundation checks `now() < reviewAfterMs` against Date.now().
     * When the device clock is set back while the countdown runs (NTP
     * correction, manual change), the button enables while the foundation
     * still refuses — BEFORE any confirmation is sent. That refusal must not
     * be shown as "may have completed", and re-entry must agree with it.
     */
    it('a refused-before-send confirmation is not "Deletion status unknown … may have completed"', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expect(journalRows()).toMatchObject([{ phase: 'ready' }]);
        const armedAt = Date.now();

        // The device clock is corrected backwards by one minute while the
        // interval keeps ticking.
        jest.setSystemTime(armedAt - 60_000);
        await advance(5_000);
        const confirm = sheetButton(renderer, 'Permanently delete');
        expect(confirm.props.disabled).toBe(false);
        await press(renderer, confirm);
        await act(async () => {});

        // Nothing left the phone.
        expect(calls('delete-confirm')).toHaveLength(0);
        expect(journalRows()).toMatchObject([{ phase: 'ready' }]);
        expectNotDeleted(renderer);

        const text = allText(renderer);
        expect(text).not.toContain('may have completed');
        expect(text).not.toContain('Deletion status unknown');
        expect(sheetButtons(renderer, 'Retry deletion')).toHaveLength(0);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('re-entry after the refused-before-send confirmation agrees with the first presentation', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
      });
      const first = renderScreen();
      let firstText: string;
      try {
        await openReview(first);
        await press(first, sheetButton(first, 'Continue to delete'));
        jest.setSystemTime(Date.now() - 60_000);
        await advance(5_000);
        await press(first, sheetButton(first, 'Permanently delete'));
        await act(async () => {});
        expect(calls('delete-confirm')).toHaveLength(0);
        firstText = allText(first);
      } finally {
        act(() => first.unmount());
      }

      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        const secondText = allText(second);
        // Both presentations describe the same journal row (phase 'ready',
        // no confirmation sent); they must not contradict each other.
        expect(firstText.includes('Deletion status unknown')).toBe(
          secondText.includes('Deletion status unknown'),
        );
        expect(firstText.includes('Delete your account?')).toBe(
          secondText.includes('Delete your account?'),
        );
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(0);
      } finally {
        act(() => second.unmount());
      }
    });
  });

  describe('ATTACK 3 — fallback flow: 409 deletion_blocked answering the first confirmation', () => {
    /**
     * The server answers `blocked` only for an operation it has already
     * CONFIRMED (auth deleted, status window closed or attempts exhausted).
     * The durable flow treats it as unresolved; the legacy fallback (local
     * database unavailable) must not treat the same reply as "nothing was
     * deleted" and re-offer "Keep my account".
     */
    it('is not rendered as a keepable account with a fresh "Continue to delete"', async () => {
      mockDatabaseUnavailable = true;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', blockedError(), 409),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});
        expect(calls('delete-confirm')).toHaveLength(1);
        expectNotDeleted(renderer);

        const text = allText(renderer);
        expect(text).not.toContain('Keep my account');
        expect(text).not.toContain('Delete your account?');
        expect(text).not.toContain('Nothing was deleted');
        expect(sheetButtons(renderer, 'Continue to delete')).toHaveLength(0);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 4 — durable flow: 429 deletion_too_fast answering the first confirmation', () => {
    /**
     * A 429 (rate limiter or the server's own minimum challenge age) is a
     * refusal issued before anything destructive ran; the candidate's own
     * fallback test pins that "the server acted on nothing" and re-arms.
     * The durable flow renders the same reply as "may have completed".
     */
    it('is not rendered as "may have completed"; the challenge re-arms and the retry confirms the same operation', async () => {
      let confirms = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => {
          confirms += 1;
          return confirms === 1
            ? reply('delete-confirm', tooFastError(), 429, {
                headers: { 'retry-after': '3' },
              })
            : reply('delete-confirm', completionPayload());
        },
        'delete-status': () => reply('delete-status', statusPayload('pending')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});
        expect(calls('delete-confirm')).toHaveLength(1);
        expectNotDeleted(renderer);
        expect(allText(renderer)).not.toContain('may have completed');
        expect(allText(renderer)).not.toContain('Deletion status unknown');
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 5 — copy: request refusals must not stack two "nothing deleted" sentences', () => {
    it('a 429 on the request does not render "Nothing was deleted. Nothing has been deleted."', async () => {
      route({
        'delete-request': () =>
          reply('delete-request', rateLimitedError(), 429, {
            headers: { 'retry-after': '60' },
          }),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        await act(async () => {});
        const text = allText(renderer);
        expect(text).not.toMatch(
          /Nothing was deleted\.\s*Nothing has been deleted\./,
        );
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('a 403 refusing the request does not render "Nothing was deleted. Nothing has been deleted."', async () => {
      route({
        'delete-request': () =>
          reply(
            'delete-request',
            { error: { code: 'forbidden', message: 'Forbidden.' } },
            403,
          ),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        await act(async () => {});
        const text = allText(renderer);
        expect(text).not.toMatch(
          /Nothing was deleted\.\s*Nothing has been deleted\./,
        );
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 6 — clock rollback during a paced "Retry request"', () => {
    /**
     * A 429 Retry-After on the request paces "Retry request" from the
     * journal's nextAttemptAtMs, but the countdown is an interval. If the
     * clock is set back, the button enables while the foundation still
     * refuses (retry_later). That local refusal must not turn into a review
     * that mints a SECOND request beside the unresolved row.
     */
    it('a locally refused retry never mints a second journal row / second request', async () => {
      route({
        'delete-request': () =>
          reply('delete-request', rateLimitedError(), 429, {
            headers: { 'retry-after': '5' },
          }),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        await act(async () => {});
        expect(calls('delete-request')).toHaveLength(1);
        expect(journalRows()).toHaveLength(1);
        const jobId = journalDocument(journalRows()[0]!).jobId;

        jest.setSystemTime(Date.now() - 60_000);
        await advance(5_000);
        const retry = sheetButton(renderer, 'Retry request');
        expect(retry.props.disabled).toBe(false);
        await press(renderer, retry);
        await act(async () => {});
        expect(calls('delete-request')).toHaveLength(1);

        // Whatever the sheet now offers as a way on, taking it must stay
        // under the same job.
        const cont = sheetButtons(renderer, 'Continue to delete');
        if (cont.length > 0) {
          await press(renderer, cont[0]!);
          await act(async () => {});
        }
        expect(journalRows()).toHaveLength(1);
        expect(journalDocument(journalRows()[0]!).jobId).toBe(jobId);
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 7 — boundary Retry-After values on the request', () => {
    it.each([
      '0',
      '-5',
      'abc',
      '1e2',
      '99999',
      ' 5',
      'Wed, 21 Oct 2015 07:28:00 GMT',
    ])(
      'Retry-After %j paces the retry with a finite positive countdown, never NaN',
      async header => {
        route({
          'delete-request': () =>
            reply('delete-request', rateLimitedError(), 429, {
              headers: { 'retry-after': header },
            }),
        });
        const renderer = renderScreen();
        try {
          await openReview(renderer);
          await press(renderer, sheetButton(renderer, 'Continue to delete'));
          await act(async () => {});
          const retry = sheetButton(renderer, 'Retry request');
          const label = String(retry.props.label);
          expect(label).not.toContain('NaN');
          expect(label).not.toContain('Infinity');
          expect(label).toMatch(/^Retry request \(\d+\)$/);
          expect(retry.props.disabled).toBe(true);
          const seconds = Number(/\((\d+)\)$/.exec(label)![1]);
          expect(seconds).toBeGreaterThan(0);
          expect(seconds).toBeLessThanOrEqual(86_400);
          expectNotDeleted(renderer);
        } finally {
          act(() => renderer.unmount());
        }
      },
    );
  });

  describe('ATTACK 8 — double submit of "Retry deletion" (status check)', () => {
    it('two presses in one frame send one status call and complete once from the receipt', async () => {
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
        await act(async () => {});
        expect(allText(renderer)).toContain('Deletion status unknown');

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
        await act(async () => {});
        expect(calls('delete-status')).toHaveLength(1);
        expect(
          useAuthStore.getState().completeAccountDeletion,
        ).toHaveBeenCalledTimes(1);
        expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 9 — replayed request reply: a second challenge for the SAME operation id', () => {
    /**
     * After a lost confirmation the sheet only polls; a stale/duplicate
     * request reply must never re-arm a challenge over the confirm_pending
     * row, and the confirmation body must keep the journaled operation id.
     */
    it('re-entry after a lost confirmation never sends a new request and never re-arms', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () =>
          reply('delete-status', statusPayload('in_progress'), 200, {
            headers: { 'retry-after': '3' },
          }),
      });
      const first = renderScreen();
      try {
        await armDeletion(first);
        await press(first, sheetButton(first, 'Permanently delete'));
        await act(async () => {});
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      } finally {
        act(() => first.unmount());
      }

      for (let launch = 0; launch < 3; launch += 1) {
        const again = renderScreen();
        try {
          await openDeleteSheet(again);
          expect(calls('delete-request')).toHaveLength(1);
          expect(sheetButtons(again, 'Permanently delete')).toHaveLength(0);
          expect(sheetButtons(again, 'Continue to delete')).toHaveLength(0);
          expect(buttonLabels(again)).not.toContain('Keep my account');
          expectNotDeleted(again);
        } finally {
          act(() => again.unmount());
        }
      }
      expect(journalRows()).toHaveLength(1);
      expect(journalRows()[0]).toMatchObject({ operation_id: deletionId(10) });
    });
  });
});
