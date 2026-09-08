import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as Keychain from 'react-native-keychain';

/**
 * W08-01 adversarial suite against candidate d2bb4905 (ManageAccountScreen on
 * the durable deletion operation). Every case drives the real screen against
 * the real SQLite journal, the in-memory Keychain mock and a routed
 * `globalThis.fetch` — the same seams as the candidate's own suite — and
 * pushes one failure boundary the candidate does not pin:
 *
 *   A1 the owner changes while a confirmation is in flight and its reply is
 *      lost (the outcome is unknown);
 *   A2 the server's challenge `expiresAt` is already in the past by the
 *      device clock (clock skew) — is the server still allowed to decide?;
 *   A3a/A3b the local database cannot be opened (corrupt persisted state) —
 *      does the shipping screen still refuse redirects and untrusted replies?;
 *   A4 the deletion-confirmed notice copy against the App Store dossier;
 *   A5 confirmation timeout (15 s, reply never arrives);
 *   A6 a redirected status reply claiming `completed`;
 *   A7 429 + Retry-After on the request step and an impatient retry press;
 *   A8 process death between the receipt journal write and the Keychain seal;
 *   A9 a Keychain capability record tampered under a pending confirmation;
 *   A10 5xx on the status poll while the server reports `in_progress`.
 *
 * Assertions state the HONEST behaviour; a failing case is a candidate break.
 */

jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

let mockDatabase: ReturnType<typeof createSqliteTestDb>;
let mockDatabaseUnavailable = false;
jest.mock('../src/data/db', () => ({
  getDb: () => {
    if (mockDatabaseUnavailable)
      throw new Error('SQLITE_CORRUPT: database disk image is malformed');
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
const BEARER_B = 'session.bearer.owner-b';
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

function requestPayload(operation = 10, expiresInMs = 900_000) {
  return {
    challenge: deletionId(operation + 1),
    expiresAt: iso(expiresInMs),
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

/** A reply shaped like React Native's fetch Response: no `redirected`
 * property, `url` = the URL the network stack actually answered. */
function reply(
  path: DeletionPath,
  payload: unknown,
  status = 200,
  options: { url?: string; headers?: Record<string, string> } = {},
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

/** Presses a paced button: while its label carries a countdown it must be
 * disabled, and the clock is advanced to the moment it re-arms. */
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

/** The dialog must present the outcome as unknown: the unknown title, no
 * "nothing was deleted" claim, and no re-armed "Permanently delete". */
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

  it('A1: an owner change while the confirmation is in flight and its reply is lost keeps the UNKNOWN outcome on screen — never a re-armed "Permanently delete" / "Keep my account"', async () => {
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
      expect(buttonLabels(renderer)).toContain('Deleting…');

      // The signed-in account is replaced while the reply is outstanding,
      // then the network drops the reply: the server may or may not have
      // deleted owner A.
      await act(async () => {
        signIn(OWNER_B, BEARER_B, 'google');
        confirm.reject(new TypeError('Network request failed'));
      });
      await act(async () => {});

      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, phase: 'confirm_pending' },
      ]);
      expectNotDeleted(renderer);
      // The journal says confirm_pending; the dialog must say so too.
      expectUnknownOutcome(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A2: a challenge whose server `expiresAt` is already past by the device clock (clock skew) is still confirmed with the server — the app never asserts "expired, nothing was deleted" on its own clock', async () => {
    route({
      'delete-request': () =>
        // Device clock ≥ 15 min ahead of the server: the freshly minted
        // 15-minute challenge reads as already expired locally.
        reply('delete-request', requestPayload(10, -60_000)),
      'delete-confirm': () => reply('delete-confirm', completionPayload()),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, operation_id: deletionId(10), phase: 'ready' },
      ]);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));

      const text = allText(renderer);
      // The server owns the challenge lifetime; the device may not declare
      // it expired without asking.
      expect(text).not.toContain('The deletion request expired');
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(bodyOf(calls('delete-confirm')[0]!)).toEqual({
        challenge: deletionId(11),
        operationId: deletionId(10),
      });
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A3a: when the local database cannot be opened the shipping path still sends redirect-rejecting, operation-bound calls', async () => {
    mockDatabaseUnavailable = true;
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => reply('delete-confirm', completionPayload()),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      const [request] = calls('delete-request');
      expect(request).toMatchObject({
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
      });

      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      const [confirm] = calls('delete-confirm');
      expect(confirm).toMatchObject({ redirect: 'error', credentials: 'omit' });
      expect(bodyOf(confirm!)).toMatchObject({ operationId: deletionId(10) });
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A3b: when the local database cannot be opened a redirected confirmation reply is still never rendered as deleted', async () => {
    mockDatabaseUnavailable = true;
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () =>
        reply('delete-confirm', completionPayload(), 200, {
          url: 'https://attacker.example/v1/me/delete-confirm',
        }),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expect(calls('delete-confirm')).toHaveLength(1);
      expectNotDeleted(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A4: the deletion-confirmed notice follows the App Store copy rules (no Android / Google Play in user-facing copy)', async () => {
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
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A5: a confirmation whose reply never arrives times out into UNKNOWN (request aborted, nothing re-sent) and completes only from the status receipt', async () => {
    let confirmSignal: AbortSignal | null | undefined;
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': init => {
        confirmSignal = init.signal;
        return new Promise<Response>(() => {});
      },
      'delete-status': () => reply('delete-status', statusPayload('completed')),
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expect(buttonLabels(renderer)).toContain('Deleting…');
      expect(sheetButton(renderer, 'Deleting…').props.disabled).toBe(true);
      expectNotDeleted(renderer);

      await advance(14_999);
      expect(buttonLabels(renderer)).toContain('Deleting…');
      await advance(1);

      expect(confirmSignal?.aborted).toBe(true);
      expectUnknownOutcome(renderer);
      expect(allText(renderer)).toContain('may have completed');
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      expect(calls('delete-confirm')).toHaveLength(1);
      expectNotDeleted(renderer);

      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(calls('delete-status')).toHaveLength(1);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A6: a redirected status reply claiming `completed` is never trusted — the outcome stays unknown and nothing is purged', async () => {
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
      expectUnknownOutcome(renderer);

      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-status')).toHaveLength(1);
      expectUnknownOutcome(renderer);
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      const [row] = journalRows();
      expect(String(row!.document)).not.toContain('"receipt":{');
      expectNotDeleted(renderer);
      // The next check still goes to the server; the operation id is kept.
      expect(sheetButtons(renderer, 'Retry deletion')).toHaveLength(1);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A7: a 429 + Retry-After on the request step is honest (nothing deleted), an impatient retry sends nothing before the window, and the retry stays under the same job', async () => {
    let attempts = 0;
    route({
      'delete-request': () => {
        attempts += 1;
        return attempts === 1
          ? reply(
              'delete-request',
              { error: { code: 'rate_limited', message: 'Slow down' } },
              429,
              { headers: { 'retry-after': '60' } },
            )
          : reply('delete-request', requestPayload());
      },
    });
    const renderer = renderScreen();
    try {
      await openReview(renderer);
      await press(renderer, sheetButton(renderer, 'Continue to delete'));

      expect(allText(renderer)).toContain('Nothing has been deleted');
      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, operation_id: null, phase: 'request_unknown' },
      ]);
      expectNotDeleted(renderer);

      // Impatient retry inside the Retry-After window: no network call.
      await press(renderer, sheetButton(renderer, 'Retry request'));
      expect(calls('delete-request')).toHaveLength(1);
      expect(allText(renderer)).toContain('Nothing has been deleted');
      expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
      expect(journalRows()).toHaveLength(1);

      await advance(60_000);
      await press(renderer, sheetButton(renderer, 'Retry request'));
      expect(calls('delete-request')).toHaveLength(2);
      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, operation_id: deletionId(10), phase: 'ready' },
      ]);
      expect(sheetButton(renderer, 'Permanently delete').props.label).toBe(
        'Permanently delete (5)',
      );
      expectNotDeleted(renderer);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('A8: a Keychain seal lost after the receipt journal write (process death between the two) never claims "nothing was deleted", and re-entry completes exactly once from the status receipt', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => reply('delete-confirm', completionPayload()),
      'delete-status': () => reply('delete-status', statusPayload('completed')),
    });
    const realWrite = Keychain.setGenericPassword;
    // The capability write succeeds; the receipt seal (the record that now
    // carries a receipt) is refused exactly once.
    let sealsRefused = 0;
    const keychainWrite = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockImplementation((username, password, options) => {
        if (!password.includes('"receipt":null') && sealsRefused === 0) {
          sealsRefused += 1;
          return Promise.reject(new Error('errSecInteractionNotAllowed'));
        }
        return realWrite(username, password, options);
      });
    const first = renderScreen();
    try {
      await armDeletion(first);
      await press(first, sheetButton(first, 'Permanently delete'));

      expect(sealsRefused).toBe(1);
      expect(journalRows()).toMatchObject([
        { owner_id: OWNER_A, operation_id: deletionId(10) },
      ]);
      const [row] = journalRows();
      expect(String(row!.document)).toContain('"receipt":{');
      // Server-verified receipt in the journal: the screen may show it as
      // unknown (conservative) but must never say nothing was deleted, and
      // must never re-arm the challenge.
      const text = allText(first);
      expect(text).not.toContain('Nothing was deleted');
      expect(text).not.toContain('Delete your account?');
      expect(
        sheetButtons(first, 'Permanently delete').filter(
          node => node.props.disabled !== true,
        ),
      ).toHaveLength(0);
      act(() => first.unmount());

      const second = renderScreen();
      try {
        await press(second, pressable(second, 'Delete account')[0]!);
        await act(async () => {});
        expect(allText(second)).not.toContain("What's making you leave?");
        expect(allText(second)).not.toContain('Nothing was deleted');
        expect(calls('delete-request')).toHaveLength(1);
        await pressWhenArmed(second, 'Retry deletion');
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-request')).toHaveLength(1);
        expect(
          useAuthStore.getState().completeAccountDeletion,
        ).toHaveBeenCalledTimes(1);
        expect(mockShowBrandNotice).toHaveBeenCalledTimes(1);
        expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
      } finally {
        act(() => second.unmount());
      }
    } finally {
      keychainWrite.mockRestore();
    }
  });

  it('A9: a tampered Keychain capability record under a pending confirmation keeps the outcome unknown — no fresh request, no status call with a conflicting capability, nothing purged', async () => {
    route({
      'delete-request': () => reply('delete-request', requestPayload()),
      'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      'delete-status': () => reply('delete-status', statusPayload('completed')),
    });
    const first = renderScreen();
    await armDeletion(first);
    await press(first, sheetButton(first, 'Permanently delete'));
    expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
    act(() => first.unmount());

    // Corrupt persisted state: the capability record's challenge window no
    // longer matches the journal (a restored / partially written record).
    expect(deletionKeychainStore.size).toBe(1);
    for (const [service, item] of deletionKeychainStore) {
      const record = JSON.parse(item.password) as Record<string, unknown>;
      deletionKeychainStore.set(service, {
        ...item,
        password: JSON.stringify({ ...record, expiresAt: iso(1_800_000) }),
      });
    }

    const second = renderScreen();
    try {
      await press(second, pressable(second, 'Delete account')[0]!);
      await act(async () => {});
      expectUnknownOutcome(second);
      expect(allText(second)).not.toContain("What's making you leave?");
      expect(calls('delete-request')).toHaveLength(1);

      await pressWhenArmed(second, 'Retry deletion');
      expect(calls('delete-status')).toHaveLength(0);
      expect(calls('delete-confirm')).toHaveLength(1);
      expectUnknownOutcome(second);
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
      expectNotDeleted(second);
    } finally {
      act(() => second.unmount());
    }
  });

  it('A10: a 5xx on the status poll while the server reports `in_progress` never reads as deleted or as nothing deleted, and the next poll completes from the receipt', async () => {
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
        return statusCalls === 1
          ? reply('delete-status', { error: { code: 'internal' } }, 503)
          : reply('delete-status', statusPayload('completed'));
      },
    });
    const renderer = renderScreen();
    try {
      await armDeletion(renderer);
      await press(renderer, sheetButton(renderer, 'Permanently delete'));
      expect(allText(renderer)).toContain('Deletion in progress');
      expect(journalRows()).toMatchObject([{ phase: 'observing' }]);
      expectNotDeleted(renderer);

      await advance(3_000);
      expect(calls('delete-status')).toHaveLength(1);
      const text = allText(renderer);
      expect(text).not.toContain('Nothing was deleted');
      expect(text).not.toContain('Delete your account?');
      expect(text).not.toContain('Account deleted');
      expect(calls('delete-confirm')).toHaveLength(1);
      expectNotDeleted(renderer);

      await pressWhenArmed(renderer, 'Retry deletion');
      expect(calls('delete-status')).toHaveLength(2);
      expect(calls('delete-confirm')).toHaveLength(1);
      expect(
        useAuthStore.getState().completeAccountDeletion,
      ).toHaveBeenCalledTimes(1);
      expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
    } finally {
      act(() => renderer.unmount());
    }
  });
});
