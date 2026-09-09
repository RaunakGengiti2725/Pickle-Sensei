import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as Keychain from 'react-native-keychain';

/**
 * W08-01 adversarial suite against candidate c77ce0b2. Each test is one
 * attack at a failure boundary of the shipping ManageAccount deletion path
 * (real screen, real SQLite journal, in-memory Keychain, routed fetch).
 * A failing test here is a candidate defect, never a candidate test.
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
  captureDataOwnerContext,
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
const HOUR_MS = 3_600_000;

/** APP_STORE_SUBMISSION.md forbids these anywhere a user can read. */
const BANNED_COPY = [
  'Android',
  'Google Play',
  'guest mode',
  'Live Court',
  'DUPR',
  'SwingVision',
  'PB Vision',
  'Selkirk',
  'JOOLA',
];

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

/** React Native's fetch Response: no `redirected`, `url` = answering URL. */
function reply(
  path: DeletionPath,
  payload: unknown,
  status = 200,
  options: {
    url?: string;
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

function journalRows() {
  return mockDatabase.native
    .prepare(
      'SELECT job_id, owner_id, operation_id, phase, revision, document FROM device_account_deletion_journal ORDER BY rowid',
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

function countdownOf(label: string): number {
  const paced = /\((\d+)\)$/.exec(label);
  return paced ? Number(paced[1]) : 0;
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

function ownerId(index: number): string {
  const digits = String(index).padStart(12, '0');
  return `33333333-3333-4333-8333-${digits}`;
}

async function press(target: TestRenderer.ReactTestInstance) {
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
  const seconds = countdownOf(String(sheetButton(renderer, label).props.label));
  if (seconds > 0) {
    expect(sheetButton(renderer, label).props.disabled).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(seconds * 1000);
    });
  }
  expect(sheetButton(renderer, label).props.disabled).toBe(false);
  await press(sheetButton(renderer, label));
}

async function openReview(renderer: TestRenderer.ReactTestRenderer) {
  await press(pressable(renderer, 'Delete account')[0]!);
  await press(pressable(renderer, 'Skip the survey')[0]!);
}

async function armDeletion(renderer: TestRenderer.ReactTestRenderer) {
  await openReview(renderer);
  await press(sheetButton(renderer, 'Continue to delete'));
  await act(async () => {
    jest.advanceTimersByTime(5_000);
  });
}

async function openDeleteSheet(renderer: TestRenderer.ReactTestRenderer) {
  await press(pressable(renderer, 'Delete account')[0]!);
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
  expect(allText(renderer)).not.toContain('Deletion status unknown');
}

function expectNotDeleted(renderer: TestRenderer.ReactTestRenderer) {
  expect(
    useAuthStore.getState().completeAccountDeletion,
  ).not.toHaveBeenCalled();
  expect(mockShowBrandNotice).not.toHaveBeenCalled();
  expect(allText(renderer)).not.toContain('Account deleted');
}

function expectCopyClean(renderer: TestRenderer.ReactTestRenderer) {
  const text = allText(renderer);
  for (const banned of BANNED_COPY) expect(text).not.toContain(banned);
  expect(text).not.toMatch(/\d+\s?%/);
}

/** The Keychain read fails (errSecInteractionNotAllowed / errSecNotAvailable)
 * from the moment `down()` is called; writes keep working. */
function keychainReadOutage() {
  let down = false;
  const get = jest
    .spyOn(Keychain, 'getGenericPassword')
    .mockImplementation(async options => {
      if (down) throw new Error('errSecInteractionNotAllowed');
      return realGetGenericPassword(options);
    });
  return {
    down: () => {
      down = true;
    },
    up: () => {
      down = false;
    },
    restore: () => get.mockRestore(),
  };
}

describe('W08-01 attacks on ManageAccount durable deletion (c77ce0b2)', () => {
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

  // ATTACK 1 — local-record failure BEFORE the confirmation is sent.
  it('A1: a Keychain read that fails before the confirmation leaves the device must not be shown as "may have completed" — nothing was sent', async () => {
    const keychain = keychainReadOutage();
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => reply('delete-confirm', completionPayload()),
      'delete-status': () => reply('delete-status', statusPayload('pending')),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      expect(journalRows()).toMatchObject([{ phase: 'ready' }]);
      keychain.down();
      await press(sheetButton(renderer, 'Permanently delete'));
      await act(async () => {});

      // Precondition of the attack: the confirmation never left the device
      // and the journal still says the challenge is merely armed.
      expect(calls('delete-confirm')).toHaveLength(0);
      expect(calls('delete-status')).toHaveLength(0);
      expect(journalRows()).toMatchObject([{ phase: 'ready' }]);
      expectNotDeleted(renderer);
      expectCopyClean(renderer);

      // The honest state: the account is provably present.
      const text = allText(renderer);
      expect(text).not.toContain('may have completed');
      expect(text).not.toContain('Deletion status unknown');
      expect(text).toMatch(/Nothing was deleted|Delete your account\?/);
    } finally {
      act(() => renderer.unmount());
      keychain.restore();
    }
  });

  // ATTACK 2 — the same never-sent confirmation, seen again after re-entry:
  // the two presentations must agree on what happened.
  it('A2: re-entering the dialog over a never-sent confirmation shows the same outcome the first presentation showed', async () => {
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
      await press(sheetButton(renderer, 'Permanently delete'));
      await act(async () => {});
      const first = allText(renderer).includes('Deletion status unknown')
        ? 'unknown'
        : 'present';

      await press(
        sheetButton(
          renderer,
          first === 'unknown' ? 'Close' : 'Keep my account',
        ),
      );
      await openDeleteSheet(renderer);
      const second = allText(renderer).includes('Deletion status unknown')
        ? 'unknown'
        : 'present';

      expect(calls('delete-confirm')).toHaveLength(0);
      expectNotDeleted(renderer);
      expect(second).toBe(first);
    } finally {
      act(() => renderer.unmount());
      keychain.restore();
    }
  });

  // ATTACK 3 — resource exhaustion by completed operations.
  it(`A3: ${JOURNAL_CAPACITY} completed deletions on one phone must not lock the next account out of deleting itself`, async () => {
    let operation = 100;
    route({
      'delete-request': () => {
        operation += 2;
        return reply('delete-request', requestPayload(operation));
      },
      'delete-confirm': () =>
        reply('delete-confirm', completionPayload(operation)),
    });
    for (let index = 0; index < JOURNAL_CAPACITY; index += 1) {
      signIn(ownerId(index), `bearer-${index}`, 'apple');
      resetCleanupSpies();
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});
        expectDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    }
    expect(journalRows()).toHaveLength(JOURNAL_CAPACITY);
    expect(journalRows().every(row => row.phase === 'receipt_verified')).toBe(
      true,
    );

    signIn(OWNER_B, BEARER_B, 'google');
    resetCleanupSpies();
    const requestsBefore = calls('delete-request').length;
    const renderer = renderScreen();
    try {
      await openReview(renderer);
      await press(sheetButton(renderer, 'Continue to delete'));
      await act(async () => {});
      expectNotDeleted(renderer);
      expectCopyClean(renderer);
      // Owner B's request must reach the server: the completed rows of
      // accounts that no longer exist are not "unfinished attempts".
      expect(calls('delete-request')).toHaveLength(requestsBefore + 1);
      expect(allText(renderer)).not.toContain(
        'come back after an earlier attempt has expired',
      );
      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
    } finally {
      act(() => renderer.unmount());
    }
  });

  // ATTACK 4 — device clock rollback between arming and confirming.
  it('A4: a clock rolled back one hour after arming must not lock "Permanently delete" behind an hour-long countdown', async () => {
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
      jest.setSystemTime(Date.now() - HOUR_MS);
      await press(sheetButton(renderer, 'Permanently delete'));
      await act(async () => {});
      expectCopyClean(renderer);

      const armed = sheetButtons(renderer, 'Permanently delete');
      const seconds = armed.length
        ? countdownOf(String(armed[0]!.props.label))
        : 0;
      // Either the confirmation went out (the server owns expiry) or the
      // device re-armed the ordinary review pause — never a 3600 s lock.
      if (calls('delete-confirm').length === 0) {
        expect(buttonLabels(renderer)).toContain(
          `Permanently delete (${seconds})`,
        );
        expect(seconds).toBeLessThanOrEqual(10);
      }
    } finally {
      act(() => renderer.unmount());
    }
  });

  // ATTACK 5 — 5xx on a status poll after the server said in_progress.
  it('A5: one 503 on a status poll must not turn "Deletion in progress" into "may have completed"', async () => {
    let polls = 0;
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () =>
        reply(
          'delete-confirm',
          { operationId: deletionId(10), state: 'in_progress' },
          202,
        ),
      'delete-status': () => {
        polls += 1;
        return polls === 1
          ? reply(
              'delete-status',
              { error: { message: 'upstream unavailable' } },
              503,
            )
          : reply('delete-status', statusPayload('in_progress'));
      },
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(sheetButton(renderer, 'Permanently delete'));
      await act(async () => {});
      expect(allText(renderer)).toContain('Deletion in progress');
      expect(journalRows()).toMatchObject([{ phase: 'observing' }]);

      await advance(3_000);
      expect(calls('delete-status')).toHaveLength(1);
      expectNotDeleted(renderer);
      expectCopyClean(renderer);

      // The server's last word was "in progress"; a failed read of the
      // status does not unsay it.
      expect(allText(renderer)).toContain('Deletion in progress');
      expect(allText(renderer)).not.toContain('may have completed');
    } finally {
      act(() => renderer.unmount());
    }
  });

  // ATTACK 6 — a press that lands while the journal is still being read.
  it('A6: "Continue to delete" pressed while the dialog is still resuming the journal must not be silently dropped', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
    });
    const gate = deferred<void>();
    let gated = true;
    const realTransaction = mockDatabase.db.transaction!.bind(mockDatabase.db);
    jest
      .spyOn(mockDatabase.db, 'transaction')
      .mockImplementation(async operation => {
        if (gated) await gate.promise;
        return realTransaction(operation);
      });
    const renderer = renderScreen();
    try {
      await openReview(renderer);
      // The resume read is still waiting on the (busy) database.
      const button = sheetButton(renderer, 'Continue to delete');
      const wasDisabled = button.props.disabled === true;
      await press(button);
      await act(async () => {});
      gated = false;
      gate.resolve();
      await advance(0);
      await advance(0);
      const sentAfterRelease = calls('delete-request').length;

      // Control: once the resume has settled the same press is carried out,
      // so the first press was dropped, not delayed.
      await press(sheetButton(renderer, 'Continue to delete'));
      await advance(0);
      expect(calls('delete-request')).toHaveLength(1);

      expectNotDeleted(renderer);
      // A press on an enabled destructive button must either be carried
      // out or the button must have been disabled while the journal was
      // being read.
      expect(wasDisabled || sentAfterRelease === 1).toBe(true);
    } finally {
      act(() => renderer.unmount());
    }
  });

  // ATTACK 7 — the server (or a replaying proxy) hands owner B the
  // operation id owner A's row already holds.
  it("A7: a step-1 reply reusing another owner's operation id never arms, never deletes, and re-enters honestly", async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload(10)),
      'delete-confirm': () => reply('delete-confirm', completionPayload(10)),
    });
    let renderer = renderScreen();
    try {
      await armDeletion(renderer);
      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, operation_id: deletionId(10), phase: 'ready' },
      ]);
    } finally {
      act(() => renderer.unmount());
    }

    signIn(OWNER_B, BEARER_B, 'google');
    resetCleanupSpies();
    renderer = renderScreen();
    try {
      await openReview(renderer);
      await press(sheetButton(renderer, 'Continue to delete'));
      await act(async () => {});
      expectNotDeleted(renderer);
      expectCopyClean(renderer);
      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, operation_id: deletionId(10), phase: 'ready' },
        { owner_id: OWNER_B, operation_id: null },
      ]);
      expect(allText(renderer)).not.toContain('may have completed');
      expect(allText(renderer)).toMatch(/Nothing (was|has been) deleted/);

      const dismiss =
        sheetButtons(renderer, 'Close')[0] ??
        sheetButton(renderer, 'Keep my account');
      await press(dismiss);
      await openDeleteSheet(renderer);
      expectNotDeleted(renderer);
      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
      expect(allText(renderer)).not.toContain('Deletion status unknown');
    } finally {
      act(() => renderer.unmount());
    }

    // Owner A's own operation is untouched by owner B's collision.
    signIn(OWNER_A, BEARER_A, 'google');
    resetCleanupSpies();
    renderer = renderScreen();
    try {
      await openDeleteSheet(renderer);
      await pressWhenArmed(renderer, 'Permanently delete');
      expectDeleted(renderer);
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(headerOf(calls('delete-confirm')[0]!, 'Authorization')).toBe(
        `Bearer ${BEARER_A}`,
      );
    } finally {
      act(() => renderer.unmount());
    }
  });

  // ATTACK 8 — a redirected status reply that claims completion.
  it('A8: a status reply answered from another URL that claims `completed` is never rendered as deleted', async () => {
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
      await press(sheetButton(renderer, 'Permanently delete'));
      await act(async () => {});
      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-status')).toHaveLength(1);
      expectNotDeleted(renderer);
      expect(allText(renderer)).toContain('Deletion status unknown');
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      expect(journalDocument(journalRows()[0])).toMatchObject({
        receipt: null,
      });
    } finally {
      act(() => renderer.unmount());
    }
  });

  // ATTACK 9 — Retry-After boundary values on a 429 answering the confirm.
  it.each([
    ['abc', 60],
    ['0', 60],
    ['-1', 60],
    ['1e3', 60],
    ['999999', 60],
    ['86401', 60],
    ['86400', 86400],
    ['7', 7],
  ])(
    'A9: a 429 confirm with Retry-After %p paces the retry at %i s, never NaN, negative or unbounded',
    async (retryAfter, expectedSeconds) => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply('delete-confirm', { error: { message: 'slow down' } }, 429, {
            headers: { 'retry-after': retryAfter },
          }),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});
        expectNotDeleted(renderer);
        expectCopyClean(renderer);
        const label = String(
          sheetButton(renderer, 'Retry deletion').props.label,
        );
        expect(label).not.toContain('NaN');
        expect(label).not.toContain('-');
        expect(countdownOf(label)).toBe(expectedSeconds);
        expect(sheetButton(renderer, 'Retry deletion').props.disabled).toBe(
          true,
        );
        expect(sheetButton(renderer, 'Close').props.disabled).toBe(false);
      } finally {
        act(() => renderer.unmount());
      }
    },
  );

  // ATTACK 10 — the confirmation reply never arrives (transport deadline).
  it('A10: a confirmation that times out is unknown, and the retry completes only from the verified status receipt', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => new Promise<Response>(() => {}),
      'delete-status': () => reply('delete-status', statusPayload('completed')),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(sheetButton(renderer, 'Permanently delete'));
      await act(async () => {});
      expect(buttonLabels(renderer)).toContain('Deleting…');
      expectNotDeleted(renderer);

      await advance(15_000);
      expect(allText(renderer)).toContain('Deletion status unknown');
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      expectNotDeleted(renderer);

      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(calls('delete-status')).toHaveLength(1);
      expectDeleted(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  // ATTACK 11 — the device clock jumps 20 minutes ahead before confirming.
  it('A11: a clock jump past the challenge expiry says nothing was deleted and a fresh request mints a new operation', async () => {
    let operation = 10;
    route({
      'delete-request': () => {
        const payload = requestPayload(operation);
        operation += 10;
        return reply('delete-request', payload);
      },
      'delete-confirm': () => reply('delete-confirm', completionPayload(20)),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      jest.setSystemTime(Date.now() + 20 * 60_000);
      await press(sheetButton(renderer, 'Permanently delete'));
      await act(async () => {});
      expect(calls('delete-confirm')).toHaveLength(0);
      expectNotDeleted(renderer);
      expect(allText(renderer)).toContain('Nothing was deleted');
      expect(allText(renderer)).not.toContain('may have completed');

      await press(sheetButton(renderer, 'Continue to delete'));
      await advance(5_000);
      expect(calls('delete-request')).toHaveLength(2);
      expect(journalRows().map(row => row.operation_id)).toEqual([
        deletionId(10),
        deletionId(20),
      ]);
      await press(sheetButton(renderer, 'Permanently delete'));
      await act(async () => {});
      expectDeleted(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  // ATTACK 12 — process death between the confirm_pending journal write and
  // the network send.
  it('A12: a relaunch over a confirm_pending row whose confirmation never left resolves through the status check, then confirms once', async () => {
    let statusState = 'pending';
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => {
        statusState = 'completed';
        return reply('delete-confirm', completionPayload());
      },
      'delete-status': () => reply('delete-status', statusPayload(statusState)),
    });
    let renderer = renderScreen();
    try {
      await armDeletion(renderer);
    } finally {
      act(() => renderer.unmount());
    }
    const [row] = journalRows();
    const document = journalDocument(row);
    const revision = Number(row!.revision) + 1;
    mockDatabase.native
      .prepare(
        'UPDATE device_account_deletion_journal SET phase = ?, revision = ?, document = ? WHERE job_id = ?',
      )
      .run(
        'confirm_pending',
        revision,
        JSON.stringify({
          ...document,
          phase: 'confirm_pending',
          revision,
          serverState: 'unknown',
        }),
        row!.job_id,
      );

    renderer = renderScreen();
    try {
      await openDeleteSheet(renderer);
      expect(allText(renderer)).toContain('Deletion status unknown');
      expectNotDeleted(renderer);
      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-status')).toHaveLength(1);
      expect(calls('delete-request')).toHaveLength(1);
      expectNotDeleted(renderer);
      expect(journalRows()).toMatchObject([{ phase: 'ready' }]);

      await pressWhenArmed(renderer, 'Permanently delete');
      expect(calls('delete-confirm')).toHaveLength(1);
      expectDeleted(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  // ATTACK 13 — the owner changes while a poll is scheduled.
  it('A13: an account switch while a status poll is pending never deletes, never re-arms, and sends nothing for the new owner', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () =>
        reply(
          'delete-confirm',
          { operationId: deletionId(10), state: 'in_progress' },
          202,
        ),
      'delete-status': () => reply('delete-status', statusPayload('completed')),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(sheetButton(renderer, 'Permanently delete'));
      await act(async () => {});
      expect(allText(renderer)).toContain('Deletion in progress');

      signIn(OWNER_B, BEARER_B, 'apple');
      await advance(3_000);
      await advance(3_000);

      expectNotDeleted(renderer);
      expectCopyClean(renderer);
      expect(calls('delete-request')).toHaveLength(1);
      expect(
        sheetButtons(renderer, 'Permanently delete').filter(
          node => node.props.disabled !== true,
        ),
      ).toHaveLength(0);
      expect(allText(renderer)).not.toContain('Delete your account?');
      for (const status of calls('delete-status'))
        expect(headerOf(status, 'Authorization')).not.toBe(
          `Bearer ${BEARER_B}`,
        );
    } finally {
      act(() => renderer.unmount());
    }
  });

  // ATTACK 14 — a verified completion reply lands after the owner changed.
  it('A14: a verified confirmation reply arriving after an account switch completes exactly once for the ORIGINAL owner', async () => {
    const confirm = deferred<Response>();
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => confirm.promise,
    });
    const contextA = { ...captureDataOwnerContext(), provider: 'google' };
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(sheetButton(renderer, 'Permanently delete'));
      signIn(OWNER_B, BEARER_B, 'apple');
      await act(async () => {
        confirm.resolve(reply('delete-confirm', completionPayload()));
      });
      await act(async () => {});
      await act(async () => {});

      const cleanup = useAuthStore.getState().completeAccountDeletion;
      // Never a deletion attributed to owner B, never a second one.
      expect(cleanup).not.toHaveBeenCalledWith(
        expect.objectContaining({ ownerKey: OWNER_B }),
      );
      expect((cleanup as jest.Mock).mock.calls.length).toBeLessThanOrEqual(1);
      if ((cleanup as jest.Mock).mock.calls.length === 1)
        expect(cleanup).toHaveBeenCalledWith(contextA);
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_B);
      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, operation_id: deletionId(10) },
      ]);
      expect(journalDocument(journalRows()[0])).toMatchObject({
        serverState: 'completed',
      });
      expectCopyClean(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });
});
