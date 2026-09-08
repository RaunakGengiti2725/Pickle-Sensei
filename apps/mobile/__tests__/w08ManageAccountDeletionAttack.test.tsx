import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as Keychain from 'react-native-keychain';

/**
 * W08-01 adversarial suite — attacks the shipping ManageAccount deletion
 * path (candidate aa491505) at its failure boundaries: crash between the
 * journal and Keychain writes, double submission, account switch while a
 * confirmation is in flight, journal capacity, clock rollback, and the
 * network failure modes of every step (timeout, 429 + Retry-After, 5xx,
 * redirect). Every case drives the real screen against a real SQLite
 * journal, the in-memory Keychain mock and a routed `globalThis.fetch`.
 *
 * A failing case here is a confirmed break of the candidate, not of this
 * file: the assertions state the behaviour the objective promises
 * ("idempotent re-entry", "honest pending/failed/completed states",
 * "unknown state never renders as deleted") and APP_STORE_SUBMISSION.md's
 * copy rules.
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

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await act(async () => {});
}

async function openReview(renderer: TestRenderer.ReactTestRenderer) {
  await press(renderer, pressable(renderer, 'Delete account')[0]!);
  await press(renderer, pressable(renderer, 'Skip the survey')[0]!);
}

async function armDeletion(renderer: TestRenderer.ReactTestRenderer) {
  await openReview(renderer);
  await press(renderer, sheetButton(renderer, 'Continue to delete'));
  await advance(5_000);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('W08-01 attack: ManageAccount deletion failure boundaries', () => {
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

  it('A1 crash boundary: a Keychain write that fails after the `securing` journal write must not strand the owner in "status unknown" on re-entry', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
    });
    // The device Keychain refuses exactly one write — the one that stores
    // the status capability right after the journal moved to `securing`.
    // This is the persisted state a process death between the two writes
    // leaves behind: journal row with an operation id, no capability.
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValueOnce(new Error('errSecInteractionNotAllowed'));

    const first = renderScreen();
    await openReview(first);
    await press(first, sheetButton(first, 'Continue to delete'));

    // The first pass is honest: nothing deleted, no confirmation offered.
    expect(sheetButtons(first, 'Permanently delete')).toHaveLength(0);
    expect(allText(first)).toContain('Nothing was deleted');
    expect(journalRows()).toMatchObject([
      { owner_id: OWNER_A, operation_id: deletionId(10), phase: 'securing' },
    ]);
    expect(deletionKeychainStore.size).toBe(0);
    expectNotDeleted(first);
    act(() => first.unmount());

    // Relaunch: the same owner opens the dialog again. No confirmation was
    // ever sent (the operation never reached `ready`), so the screen must
    // not claim the request "may have completed", and it must leave the
    // owner a way to delete the account — a fresh request or a retry.
    const second = renderScreen();
    try {
      await press(second, pressable(second, 'Delete account')[0]!);
      await act(async () => {});
      const observe = () => {
        const text = allText(second);
        return {
          claimsMayHaveCompleted: text.includes('may have completed'),
          rendersStatusUnknown: text.includes('Deletion status unknown'),
          offersSurvey: text.includes("What's making you leave?"),
          buttons: buttonLabels(second),
        };
      };
      const onReentry = observe();
      // If the screen offers a retry, take it: the owner must not be stuck.
      if (sheetButtons(second, 'Retry deletion').length > 0) {
        await pressWhenArmed(second, 'Retry deletion');
      }
      const afterRetry = observe();
      expectNotDeleted(second);
      expect(calls('delete-status')).toHaveLength(0);
      expect({ onReentry, afterRetry }).toEqual({
        onReentry: expect.objectContaining({
          claimsMayHaveCompleted: false,
          rendersStatusUnknown: false,
        }),
        afterRetry: expect.objectContaining({
          claimsMayHaveCompleted: false,
          rendersStatusUnknown: false,
        }),
      });
      expect(
        afterRetry.offersSurvey ||
          afterRetry.buttons.some(
            label =>
              label.startsWith('Continue to delete') ||
              label.startsWith('Retry request'),
          ),
      ).toBe(true);
    } finally {
      act(() => second.unmount());
    }
  });

  it('A2 double submission: two presses of "Continue to delete" in one frame must mint one delete-request, one journal entry', async () => {
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
      expect(journalRows()).toHaveLength(1);
      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, operation_id: deletionId(10), phase: 'ready' },
      ]);
      expectNotDeleted(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A3 reentrancy: two presses of "Permanently delete" in one frame must not report an account change or an unknown outcome while the single confirmation is in flight', async () => {
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

      // Exactly one confirmation left the device and it is still pending:
      // the only honest rendering is "Deleting…".
      expect(calls('delete-confirm')).toHaveLength(1);
      const text = allText(renderer);
      expectNotDeleted(renderer);
      expect({
        claimsAccountChanged: text.includes('The signed-in account changed.'),
        rendersStatusUnknown: text.includes('Deletion status unknown'),
        claimsMayHaveCompleted: text.includes('may have completed'),
        buttons: buttonLabels(renderer),
      }).toEqual({
        claimsAccountChanged: false,
        rendersStatusUnknown: false,
        claimsMayHaveCompleted: false,
        buttons: ['Keep my account', 'Deleting…'],
      });

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

  it('A4 journal capacity: an owner who abandoned a request on 32 different days must still be able to delete the account', async () => {
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
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A5 account switch in flight: a completion that lands after the owner changed is applied to the ORIGINAL owner only', async () => {
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

      // Owner B signs in on this device while A's confirmation is in flight.
      await act(async () => {
        signIn(OWNER_B, BEARER_B, 'apple');
      });
      await act(async () => {
        confirm.resolve(reply('delete-confirm', completionPayload()));
      });
      await act(async () => {});

      const cleanup = useAuthStore.getState().completeAccountDeletion;
      expect(cleanup).toHaveBeenCalledTimes(1);
      const [context] = (cleanup as jest.Mock).mock.calls[0] as [
        { ownerKey: string; provider: string },
      ];
      expect(context.ownerKey).toBe(OWNER_A);
      expect(context.provider).toBe('google');
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_B);
      // The receipt belongs to A's operation; nothing was journaled for B.
      expect(journalRows()).toMatchObject([
        {
          owner_id: OWNER_A,
          operation_id: deletionId(10),
          phase: 'receipt_verified',
        },
      ]);
      expect(calls('delete-request')).toHaveLength(1);
      expect(calls('delete-status')).toHaveLength(0);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A6 429 + Retry-After on confirm: honours the wait, never re-sends before the server allows, recovers through status under the same operation', async () => {
    let confirms = 0;
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => {
        confirms += 1;
        return confirms === 1
          ? reply(
              'delete-confirm',
              { error: { code: 'rate_limited', message: 'Slow down.' } },
              429,
              { headers: { 'retry-after': '7' } },
            )
          : reply('delete-confirm', completionPayload());
      },
      'delete-status': () => reply('delete-status', statusPayload('pending')),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));

      expect(allText(renderer)).not.toContain('Account deleted');
      expect(allText(renderer)).not.toContain('Nothing was deleted');
      expectNotDeleted(renderer);
      const paced = sheetButton(renderer, 'Retry deletion');
      expect(paced.props.disabled).toBe(true);
      expect(paced.props.label).toBe('Retry deletion (7)');

      // 6s in: still held back, nothing re-sent.
      await advance(6_000);
      expect(sheetButton(renderer, 'Retry deletion').props.disabled).toBe(true);
      expect(calls('delete-status')).toHaveLength(0);
      expect(calls('delete-confirm')).toHaveLength(1);

      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-status')).toHaveLength(1);
      expect(allText(renderer)).toContain('Delete your account?');
      expectNotDeleted(renderer);

      await pressWhenArmed(renderer, 'Permanently delete');
      expect(calls('delete-request')).toHaveLength(1);
      expect(calls('delete-confirm').map(bodyOf)).toEqual([
        { challenge: deletionId(11), operationId: deletionId(10) },
        { challenge: deletionId(11), operationId: deletionId(10) },
      ]);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A7 confirm timeout: a reply that arrives after the deadline is never trusted; the outcome is recovered through status only', async () => {
    const late = deferred<Response>();
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => late.promise,
      'delete-status': () => reply('delete-status', statusPayload('completed')),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expect(buttonLabels(renderer)).toContain('Deleting…');

      // The transport deadline (15s) passes with no reply.
      await advance(15_000);
      expect(allText(renderer)).toContain('Deletion status unknown');
      expect(allText(renderer)).not.toContain('Nothing was deleted');
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      expectNotDeleted(renderer);

      // The real reply lands late — it must not complete anything.
      await act(async () => {
        late.resolve(reply('delete-confirm', completionPayload()));
      });
      await act(async () => {});
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      expectNotDeleted(renderer);

      await pressWhenArmed(renderer, 'Retry deletion');
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

  it('A8 redirected status poll: a "completed" status answered from another URL never renders as deleted', async () => {
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
      expect(allText(renderer)).toContain('Deletion status unknown');

      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-status')).toHaveLength(1);
      expect(allText(renderer)).toContain('Deletion status unknown');
      expect(allText(renderer)).not.toContain('Nothing was deleted');
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      expect(String(journalRows()[0]!.phase)).not.toBe('receipt_verified');
      expectNotDeleted(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A9 5xx while in progress: server errors on the status poll never become "deleted" or "nothing was deleted"; a later receipt completes', async () => {
    const statuses = [503, 502, 500, 200];
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () =>
        reply(
          'delete-confirm',
          { operationId: deletionId(10), state: 'in_progress' },
          202,
          { headers: { 'retry-after': '2' } },
        ),
      'delete-status': () => {
        const status = statuses.shift() ?? 200;
        return status === 200
          ? reply('delete-status', statusPayload('completed'))
          : reply('delete-status', { error: { code: 'internal' } }, status);
      },
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expect(allText(renderer)).toContain('Deletion in progress');
      expectNotDeleted(renderer);

      await advance(2_000);
      expect(calls('delete-status')).toHaveLength(1);
      const afterOutage = allText(renderer);
      expect(afterOutage).not.toContain('Nothing was deleted');
      expect(afterOutage).not.toContain('Account deleted');
      expect(
        afterOutage.includes('Deletion in progress') ||
          afterOutage.includes('Deletion status unknown'),
      ).toBe(true);
      expectNotDeleted(renderer);

      // Keep asking until the server answers; every 5xx stays honest.
      for (let round = 0; round < 3; round += 1) {
        if (sheetButtons(renderer, 'Retry deletion').length > 0) {
          await pressWhenArmed(renderer, 'Retry deletion');
        } else {
          await advance(5_000);
        }
        if (calls('delete-status').length >= 4) break;
        expect(allText(renderer)).not.toContain('Nothing was deleted');
        expectNotDeleted(renderer);
      }
      expect(calls('delete-status')).toHaveLength(4);
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A10 clock rollback while armed: the confirmation is refused, nothing is sent, and the owner is told why', async () => {
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
      // The device clock jumps back an hour (NTP correction, manual change).
      jest.setSystemTime(Date.now() - 3_600_000);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));

      expect(calls('delete-confirm')).toHaveLength(0);
      expectNotDeleted(renderer);
      expect(allText(renderer)).not.toContain('Deletion status unknown');
      const label = String(
        sheetButton(renderer, 'Permanently delete').props.label,
      );
      const paced = /\((\d+)\)$/.exec(label);
      const countdownSeconds = paced ? Number(paced[1]) : 0;
      // A silent hour-long re-arm with no message is not an honest state:
      // either the pacing stays within the 5s arm delay, or the owner is
      // told the clock is the reason.
      const explainsClock = /clock/i.test(allText(renderer));
      expect({
        label,
        explainsClock,
        honest: countdownSeconds <= 5 || explainsClock,
      }).toEqual({ label, explainsClock, honest: true });
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A12 corrupt persisted state: a tampered journal row is never rendered as deleted and does not take the deletion path down', async () => {
    let requests = 0;
    route({
      'delete-request': () => {
        requests += 1;
        return reply('delete-request', requestPayload(requests * 10));
      },
      'delete-confirm': () => reply('delete-confirm', completionPayload(20)),
    });
    const first = renderScreen();
    await armDeletion(first);
    expect(journalRows()).toMatchObject([{ phase: 'ready' }]);
    act(() => first.unmount());

    // Storage corruption between launches: the row survives, its document
    // does not (a receipt appears where none was ever verified).
    mockDatabase.native
      .prepare(
        'UPDATE device_account_deletion_journal SET document = ?, phase = ?',
      )
      .run(
        JSON.stringify({
          version: 1,
          phase: 'receipt_verified',
          receipt: {
            completedAt: iso(0),
            appleAuthorizationRevocation: 'revoked',
          },
        }),
        'receipt_verified',
      );

    const second = renderScreen();
    try {
      await press(second, pressable(second, 'Delete account')[0]!);
      await act(async () => {});
      expectNotDeleted(second);
      const text = allText(second);
      expect(text).not.toContain('Account deleted');
      expect(text).not.toContain('may have completed');

      // The owner must still be able to delete the account from here.
      if (text.includes("What's making you leave?")) {
        await press(second, pressable(second, 'Skip the survey')[0]!);
        await press(second, sheetButton(second, 'Continue to delete'));
      }
      expect(allText(second)).not.toContain('could not be recorded');
      await pressWhenArmed(second, 'Permanently delete');
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
    } finally {
      act(() => second.unmount());
    }
  });

  it('A13 copy vs. affordance: a superseded operation that tells the owner to "Start again" must offer a way to do so', async () => {
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
      expectNotDeleted(renderer);
      const text = allText(renderer);
      const buttons = buttonLabels(renderer);
      expect(text).toContain('Start again to continue');
      expect({
        buttons,
        canStartAgain:
          buttons.some(label => label.startsWith('Continue to delete')) ||
          text.includes("What's making you leave?"),
      }).toEqual({ buttons, canStartAgain: true });
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A11 copy: the iOS "Account deleted" notice must not mention Google Play (APP_STORE_SUBMISSION.md)', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => reply('delete-confirm', completionPayload()),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      await act(async () => {});
      expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
      const [notice] = mockShowBrandNotice.mock.calls[0] as [
        { title: string; detail: string },
      ];
      expect(notice.title).toBe('Account deleted');
      expect(notice.detail).not.toMatch(/Google Play|Android/);
    } finally {
      act(() => renderer.unmount());
    }
  });
});
