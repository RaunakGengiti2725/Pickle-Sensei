import React from 'react';
import { Text } from 'react-native';
import * as Keychain from 'react-native-keychain';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * W08-01 adversarial tests against candidate 8dab3b85 — every test drives the
 * real ManageAccountScreen over the real durable operation, SQLite journal,
 * Keychain mock and a routed `globalThis.fetch`, exactly like the candidate's
 * own suite, and pushes on a boundary the candidate does not pin:
 *
 *   - the server's `blocked` status AFTER a confirmation was sent (the edge
 *     function only reports `blocked` for a confirmed operation whose worker
 *     cannot finish — auth user already gone, retry budget exhausted, or the
 *     status window lapsed — and its own message is "Account deletion could
 *     not be completed. Check its status or contact support.");
 *   - the 24 h status window lapsing while a confirmation is still being
 *     observed or still unresolved;
 *   - a corrupt journal document over a sent confirmation;
 *   - Retry-After boundary values;
 *   - user-facing copy on every deletion state.
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
    statusExpiresAt: iso(24 * HOUR_MS),
  };
}

function statusPayload(state: string) {
  return {
    state,
    completionReceipt: state === 'completed' ? { completedAt: iso(0) } : null,
    appleAuthorizationRevocation: state === 'completed' ? 'revoked' : null,
  };
}

/** supabase/functions/api/index.ts — confirm reply once the confirmed
 * operation's lease cannot be claimed (`acquire_account_deletion_lease`
 * → 'blocked'). */
function deletionBlockedError() {
  return {
    error: {
      code: 'account.deletion_blocked',
      message:
        'Account deletion could not be completed. Check its status or contact support.',
    },
  };
}

function reply(
  path: DeletionPath,
  payload: unknown,
  status = 200,
  options: { headers?: Record<string, string> } = {},
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    url: `${ORIGIN}/v1/me/${path}`,
    headers: {
      get: (name: string) => options.headers?.[name.toLowerCase()] ?? null,
    },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  } as unknown as Response;
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

function journalReads(): number {
  return mockDatabase.calls.filter(
    call =>
      call.sql.startsWith('SELECT') &&
      call.sql.includes('device_account_deletion_journal'),
  ).length;
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

async function armDeletion(renderer: TestRenderer.ReactTestRenderer) {
  await press(renderer, pressable(renderer, 'Delete account')[0]!);
  await press(renderer, pressable(renderer, 'Skip the survey')[0]!);
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

/** After a confirmation was SENT, the only honest renderings are "unknown"
 * or "in progress": no claim that nothing was deleted, no re-armed request. */
function expectSentConfirmationHonest(
  renderer: TestRenderer.ReactTestRenderer,
) {
  const text = allText(renderer);
  expect(text).not.toContain('Nothing was deleted');
  expect(text).not.toContain('Nothing has been deleted');
  expect(text).not.toContain('Delete your account?');
  expect(text).not.toContain('Keep my account');
  expect(sheetButtons(renderer, 'Continue to delete')).toHaveLength(0);
  expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
}

/** Drives owner A to a sent-but-unresolved confirmation (network lost). */
async function loseConfirmation(renderer: TestRenderer.ReactTestRenderer) {
  await armDeletion(renderer);
  await press(renderer, sheetButton(renderer, 'Permanently delete'));
  expect(allText(renderer)).toContain('Deletion status unknown');
  expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
}

const FORBIDDEN_COPY = [
  'Android',
  'Google Play',
  'guest mode',
  'Live Court',
  'DUPR',
  'SwingVision',
  'PB Vision',
];

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
    globalThis.fetch = realFetch;
    clearApiSession();
    mockDatabase.close();
    jest.useRealTimers();
  });

  it('ATTACK 1 — a `blocked` status after a SENT confirmation must not render as "Nothing was deleted" and re-arm a new request', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      'delete-status': () => reply('delete-status', statusPayload('blocked')),
    });
    const renderer = renderScreen();
    try {
      await loseConfirmation(renderer);

      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-status')).toHaveLength(1);
      expect(calls('delete-confirm')).toHaveLength(1);
      expectNotDeleted(renderer);
      // The server said the confirmed deletion could not be completed — it
      // did NOT say the account is still there.
      expectSentConfirmationHonest(renderer);
      expect(journalRows()).toMatchObject([
        { operation_id: deletionId(10), phase: 'observing' },
      ]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('ATTACK 2 — 409 account.deletion_blocked on the confirmation stays unknown through the status poll and across re-entry', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () =>
        reply('delete-confirm', deletionBlockedError(), 409),
      'delete-status': () => reply('delete-status', statusPayload('blocked')),
    });
    const first = renderScreen();
    await armDeletion(first);
    await press(first, sheetButton(first, 'Permanently delete'));
    expect(allText(first)).toContain('Deletion status unknown');
    expectSentConfirmationHonest(first);
    expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);

    await pressWhenArmed(first, 'Retry deletion');
    expect(calls('delete-status')).toHaveLength(1);
    expectNotDeleted(first);
    expectSentConfirmationHonest(first);
    act(() => first.unmount());

    // Re-entry: the confirmed-but-blocked operation is still this owner's
    // unfinished deletion — never a fresh survey over it.
    const second = renderScreen();
    try {
      await openDeleteSheet(second);
      expect(allText(second)).not.toContain("What's making you leave?");
      expectSentConfirmationHonest(second);
      expectNotDeleted(second);
    } finally {
      act(() => second.unmount());
    }
  });

  it('ATTACK 3 — the status window lapsing while a confirmation is observed must not become a zero-delay poll storm', async () => {
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
    const first = renderScreen();
    await armDeletion(first);
    await press(first, sheetButton(first, 'Permanently delete'));
    expect(allText(first)).toContain('Deletion in progress');
    expect(journalRows()).toMatchObject([{ phase: 'observing' }]);
    act(() => first.unmount());

    // Process death; the app comes back 25 hours later, after statusExpiresAt.
    jest.setSystemTime(Date.now() + 25 * HOUR_MS);
    const statusCallsBefore = calls('delete-status').length;
    const second = renderScreen();
    try {
      await openDeleteSheet(second);
      const readsAfterOpen = journalReads();
      for (let round = 0; round < 25; round += 1) await advance(0);
      const readsAfterIdle = journalReads() - readsAfterOpen;
      // No network call can be made (the window lapsed), so the screen must
      // settle: a bounded number of journal reads, no timer re-armed at 0 ms.
      expect(calls('delete-status')).toHaveLength(statusCallsBefore);
      expect(readsAfterIdle).toBeLessThanOrEqual(3);
      expectNotDeleted(second);
      // ...and the user must be told the window closed instead of watching
      // a spinner that will never resolve.
      expect(allText(second)).toMatch(/window|support/i);
    } finally {
      act(() => second.unmount());
    }
  });

  it('ATTACK 4 — after the status window lapses, "Retry deletion" must not be a silent no-op that hides the window-closed message', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      'delete-status': () =>
        reply('delete-status', statusPayload('in_progress')),
    });
    const first = renderScreen();
    await loseConfirmation(first);
    act(() => first.unmount());

    jest.setSystemTime(Date.now() + 25 * HOUR_MS);
    const second = renderScreen();
    try {
      await openDeleteSheet(second);
      expect(allText(second)).toContain('Deletion status unknown');
      const retry = sheetButton(second, 'Retry deletion');
      expect(retry.props.disabled).toBe(false);
      await press(second, retry);
      await press(second, sheetButton(second, 'Retry deletion'));
      expectNotDeleted(second);
      // Either the status is actually asked for, or the user is told the
      // window has closed; a live button that does nothing is neither.
      if (calls('delete-status').length === 0) {
        expect(allText(second)).toMatch(
          /window for checking this deletion has closed/,
        );
      }
    } finally {
      act(() => second.unmount());
    }
  });

  it('ATTACK 5 — a corrupt journal document over a SENT confirmation must not re-enter as an empty history (fresh survey)', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
    });
    const first = renderScreen();
    await loseConfirmation(first);
    act(() => first.unmount());

    // The table's CHECK keeps the column valid JSON, so the corruption that
    // can land is semantic: a document the contract parser rejects.
    const [row] = journalRows();
    const document = JSON.parse(String(row!.document)) as Record<
      string,
      unknown
    >;
    mockDatabase.native
      .prepare('UPDATE device_account_deletion_journal SET document = ?')
      .run(JSON.stringify({ ...document, phase: 'confirm_pendin' }));

    const second = renderScreen();
    try {
      await openDeleteSheet(second);
      expectNotDeleted(second);
      const text = allText(second);
      expect(text).not.toContain("What's making you leave?");
      expect(text).not.toContain('Delete your account?');
      expect(text).not.toContain('Nothing was deleted');
    } finally {
      act(() => second.unmount());
    }
  });

  it('ATTACK 6 — Retry-After boundary values on a 429 confirmation never pace the retry beyond the transport ceiling or below zero', async () => {
    const retryAfters = ['99999', '0', '-5', 'abc', '86401'];
    let index = 0;
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () =>
        reply('delete-confirm', { error: { message: 'slow down' } }, 429, {
          headers: {
            'retry-after': retryAfters[index++ % retryAfters.length]!,
          },
        }),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expectNotDeleted(renderer);
      for (let attempt = 0; attempt < retryAfters.length; attempt += 1) {
        const label = String(
          sheetButton(renderer, 'Retry deletion').props.label,
        );
        const paced = /\((\d+)\)$/.exec(label);
        const seconds = paced ? Number(paced[1]) : 0;
        expect(seconds).toBeGreaterThanOrEqual(0);
        expect(seconds).toBeLessThanOrEqual(60);
        await pressWhenArmed(renderer, 'Retry deletion');
        expectNotDeleted(renderer);
      }
      expect(calls('delete-status')).toHaveLength(retryAfters.length);
      expect(calls('delete-confirm')).toHaveLength(1);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('ATTACK 7 — every deletion state renders App Store-only copy (no Android / Google Play / guest / Live Court / DUPR / competitors)', async () => {
    let confirmAttempts = 0;
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => {
        confirmAttempts += 1;
        return confirmAttempts === 1
          ? Promise.reject(new TypeError('Network lost'))
          : reply(
              'delete-confirm',
              { operationId: deletionId(10), state: 'in_progress' },
              202,
              { headers: { 'retry-after': '2' } },
            );
      },
      'delete-status': () => reply('delete-status', statusPayload('pending')),
    });
    const renderer = renderScreen();
    try {
      const seen: string[] = [];
      const record = () => seen.push(allText(renderer));
      await press(renderer, pressable(renderer, 'Delete account')[0]!);
      record();
      await press(renderer, pressable(renderer, 'Skip the survey')[0]!);
      record();
      await press(renderer, sheetButton(renderer, 'Continue to delete'));
      record();
      await advance(5_000);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      record();
      await pressWhenArmed(renderer, 'Retry deletion');
      record();
      await pressWhenArmed(renderer, 'Permanently delete');
      record();
      for (const text of seen) {
        for (const word of FORBIDDEN_COPY) expect(text).not.toContain(word);
      }
      expect(buttonLabels(renderer)).toEqual(['Close']);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('ATTACK 8 — a receipt in hand whose Keychain seal is lost (crash between seal steps) is never rendered deleted until the seal lands, then deleted exactly once', async () => {
    let statusReplies = 0;
    // One server-side completion: confirm and status report the SAME receipt.
    const completionReceipt = { completedAt: iso(0) };
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () =>
        reply('delete-confirm', {
          deleted: true,
          operationId: deletionId(10),
          completionReceipt,
          appleAuthorizationRevocation: 'revoked',
        }),
      'delete-status': () => {
        statusReplies += 1;
        return statusReplies === 1
          ? Promise.reject(new TypeError('Network lost'))
          : reply('delete-status', {
              state: 'completed',
              completionReceipt,
              appleAuthorizationRevocation: 'revoked',
            });
      },
    });
    // The journal already holds the receipt (`receipt_pending`) when the
    // Keychain refuses the seal write — the state a process death between the
    // two writes leaves behind.
    // (The foundation captures the Keychain functions once per database, so
    // the refusal is toggled rather than the spy restored.)
    let refuseReceiptSeal = true;
    const mockedWrite = Keychain.setGenericPassword;
    const keychainWrite = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockImplementation(async (...args) => {
        const secret = JSON.parse(String(args[1])) as { receipt?: unknown };
        if (refuseReceiptSeal && secret.receipt)
          throw new Error('errSecInteractionNotAllowed');
        return mockedWrite(...args);
      });
    try {
      const first = renderScreen();
      await armDeletion(first);
      await press(first, sheetButton(first, 'Permanently delete'));
      expectNotDeleted(first);
      expectSentConfirmationHonest(first);
      expect(journalRows()).toMatchObject([{ phase: 'receipt_pending' }]);
      act(() => first.unmount());

      // Relaunch with the Keychain still refusing and the network down.
      const second = renderScreen();
      await openDeleteSheet(second);
      expect(allText(second)).toContain('Deletion status unknown');
      expectSentConfirmationHonest(second);
      await pressWhenArmed(second, 'Retry deletion');
      expectNotDeleted(second);
      expectSentConfirmationHonest(second);
      expect(journalRows()).toMatchObject([{ phase: 'receipt_pending' }]);
      act(() => second.unmount());

      // Keychain recovers: the SAME receipt seals and the account is deleted
      // exactly once — no second confirmation, no new request.
      refuseReceiptSeal = false;
      const third = renderScreen();
      try {
        await openDeleteSheet(third);
        await pressWhenArmed(third, 'Retry deletion');
        expect(
          useAuthStore.getState().completeAccountDeletion,
        ).toHaveBeenCalledTimes(1);
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
      } finally {
        act(() => third.unmount());
      }
    } finally {
      keychainWrite.mockRestore();
    }
  });
});
