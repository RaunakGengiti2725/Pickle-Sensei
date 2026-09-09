import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * W08-01 adversarial attacks against candidate 581e842b.
 *
 * Every test drives the real ManageAccountScreen against a real SQLite
 * journal, the in-memory Keychain mock and a routed `globalThis.fetch` —
 * the same seams the shipping app uses. Each attack targets a failure
 * boundary the objective names (redirect rejection, idempotent re-entry,
 * honest pending/failed/completed states, unknown never rendered as
 * deleted) and asserts the honest behaviour; a failing test is a break.
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
/** deletionOperationTransport request deadline. */
const TRANSPORT_TIMEOUT_MS = 15_000;

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

/** A reply shaped like React Native's fetch Response: no `redirected`
 * property, `url` = the URL the network stack actually answered. */
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
    text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
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

function textNodes(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByType(Text);
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

async function settle() {
  await act(async () => {});
  await act(async () => {});
}

function ownerId(index: number): string {
  const digits = String(index).padStart(12, '0');
  return `33333333-3333-4333-8333-${digits}`;
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

/** Presses a paced button once its countdown has run out. */
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
  await settle();
}

function expectDeletedOnce() {
  expect(useAuthStore.getState().completeAccountDeletion).toHaveBeenCalledTimes(
    1,
  );
  expect(mockShowBrandNotice).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Account deleted' }),
  );
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

/** The dialog says the outcome is unknown: no re-armed destructive action,
 * no "keep" reassurance, no claim that nothing was deleted. */
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

/** The challenge is armed for the SAME operation: nothing was sent, nothing
 * is claimed. */
function expectArmed(
  renderer: TestRenderer.ReactTestRenderer,
  operation: number,
) {
  const text = allText(renderer);
  expect(text).toContain('Delete your account?');
  expect(text).not.toContain('Deletion status unknown');
  expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
  expect(journalRows()).toMatchObject([
    { owner_id: OWNER_A, operation_id: deletionId(operation), phase: 'ready' },
  ]);
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

describe('W08-01 attacks on the ManageAccount deletion path', () => {
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

  describe('ATTACK 1 — network: the confirmation hangs until the transport deadline', () => {
    it('a confirmation that never answers is UNKNOWN after the deadline (never deleted, never re-armed), sent exactly once, and completes only from the status receipt', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => new Promise<Response>(() => {}),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));

        // Still waiting: the destructive control is gone, nothing is claimed.
        expect(sheetButton(renderer, 'Deleting…').props.disabled).toBe(true);
        expectNotDeleted(renderer);

        await advance(TRANSPORT_TIMEOUT_MS - 1);
        expect(allText(renderer)).not.toContain('Deletion status unknown');
        expectNotDeleted(renderer);

        await advance(2);
        expectUnknownOutcome(renderer);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-status')).toHaveLength(0);
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
        expectNotDeleted(renderer);

        await pressWhenArmed(renderer, 'Retry deletion');
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-status')).toHaveLength(1);
        expect(bodyOf(calls('delete-status')[0]!)).toEqual({
          operationId: deletionId(10),
        });
        expectDeletedOnce();
        expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('a status poll that hangs past the deadline after a server "in progress" stays in progress/unknown and is never re-armed', async () => {
      let statusCalls = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply(
            'delete-confirm',
            { operationId: deletionId(10), state: 'in_progress' },
            202,
            { headers: { 'retry-after': '1' } },
          ),
        'delete-status': () => {
          statusCalls += 1;
          return statusCalls === 1
            ? new Promise<Response>(() => {})
            : reply('delete-status', statusPayload('completed'));
        },
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(allText(renderer)).toContain('Deletion in progress');
        await advance(1_000);
        expect(calls('delete-status')).toHaveLength(1);

        await advance(TRANSPORT_TIMEOUT_MS + 1);
        const text = allText(renderer);
        expect(text).not.toContain('Delete your account?');
        expect(text).not.toContain('Nothing was deleted');
        expect(text).not.toContain('Nothing has been deleted');
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
        expectNotDeleted(renderer);
        expect(calls('delete-confirm')).toHaveLength(1);

        // The paced retry reaches the server and completes from the receipt.
        if (sheetButtons(renderer, 'Retry deletion').length > 0) {
          await pressWhenArmed(renderer, 'Retry deletion');
        } else {
          await advance(60_000);
        }
        expect(calls('delete-status').length).toBeGreaterThanOrEqual(2);
        expect(calls('delete-confirm')).toHaveLength(1);
        expectDeletedOnce();
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 2 — network: 5xx at every step', () => {
    it('a 503 on the request is "nothing deleted" (stated once) and the retry reuses the same journal job; a 503 on the confirmation is UNKNOWN; a 503 on the status check stays UNKNOWN; only the receipt completes', async () => {
      let requests = 0;
      let confirms = 0;
      let statuses = 0;
      route({
        'delete-request': () => {
          requests += 1;
          return requests === 1
            ? reply('delete-request', { error: { message: 'upstream' } }, 503)
            : reply('delete-request', requestPayload());
        },
        'delete-confirm': () => {
          confirms += 1;
          return reply('delete-confirm', { error: { message: 'boom' } }, 500);
        },
        'delete-status': () => {
          statuses += 1;
          return statuses === 1
            ? reply('delete-status', { error: { message: 'boom' } }, 502)
            : reply('delete-status', statusPayload('completed'));
        },
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));

        let text = allText(renderer);
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
        expect(text).not.toContain('Deletion status unknown');
        expect(countMatches(text, /Nothing (?:was|has been) deleted/g)).toBe(1);
        const [firstRow] = journalRows();
        expect(firstRow).toMatchObject({ phase: 'request_unknown' });
        const jobId = (
          JSON.parse(String(firstRow!.document)) as { jobId: string }
        ).jobId;
        expectNotDeleted(renderer);

        await pressWhenArmed(renderer, 'Retry request');
        expect(calls('delete-request')).toHaveLength(2);
        const rows = journalRows();
        expect(rows).toHaveLength(1);
        expect(
          (JSON.parse(String(rows[0]!.document)) as { jobId: string }).jobId,
        ).toBe(jobId);
        expect(rows[0]).toMatchObject({
          operation_id: deletionId(10),
          phase: 'ready',
        });

        await advance(5_000);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectUnknownOutcome(renderer);
        expect(confirms).toBe(1);
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
        expectNotDeleted(renderer);

        await pressWhenArmed(renderer, 'Retry deletion');
        expect(statuses).toBe(1);
        expectUnknownOutcome(renderer);
        expect(confirms).toBe(1);
        expect(calls('delete-request')).toHaveLength(2);
        expectNotDeleted(renderer);

        await pressWhenArmed(renderer, 'Retry deletion');
        expect(statuses).toBe(2);
        expectDeletedOnce();
        expect(confirms).toBe(1);
        text = allText(renderer);
        expect(text).not.toContain('Deletion status unknown');
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 3 — network: 429 + Retry-After on the FIRST durable confirmation', () => {
    it('a rate-limited first confirmation never renders as deleted, never mints a second request, paces the retry by Retry-After, and the same challenge is confirmed once the server says it is still pending', async () => {
      let confirms = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => {
          confirms += 1;
          return confirms === 1
            ? reply(
                'delete-confirm',
                { error: { message: 'slow down' } },
                429,
                {
                  headers: { 'retry-after': '7' },
                },
              )
            : reply('delete-confirm', completionPayload());
        },
        'delete-status': () => reply('delete-status', statusPayload('pending')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));

        // The server acted on nothing, but the client cannot know the 429
        // was not answered after processing: it must not claim "deleted",
        // must not mint a fresh request, and must honour Retry-After.
        expectNotDeleted(renderer);
        expect(calls('delete-request')).toHaveLength(1);
        expect(journalRows()).toHaveLength(1);
        const text = allText(renderer);
        expect(text).not.toContain('Account deleted');
        const paced = [
          ...sheetButtons(renderer, 'Retry deletion'),
          ...sheetButtons(renderer, 'Permanently delete'),
        ];
        expect(paced).toHaveLength(1);
        expect(String(paced[0]!.props.label)).toMatch(/\(7\)$/);
        expect(paced[0]!.props.disabled).toBe(true);

        // Before Retry-After has elapsed nothing further goes out.
        await advance(6_000);
        expect(confirms).toBe(1);
        expect(calls('delete-status')).toHaveLength(0);

        const label = sheetButtons(renderer, 'Retry deletion').length
          ? 'Retry deletion'
          : 'Permanently delete';
        await pressWhenArmed(renderer, label);
        // Whether the sheet re-checked (status → pending) or re-sent, the
        // operation is the same and the challenge is confirmed exactly once
        // more, under the same operation id.
        if (confirms === 1) {
          expect(calls('delete-status')).toHaveLength(1);
          expectArmed(renderer, 10);
          await pressWhenArmed(renderer, 'Permanently delete');
        }
        expect(confirms).toBe(2);
        expect(calls('delete-confirm').map(bodyOf)).toEqual([
          { challenge: deletionId(11), operationId: deletionId(10) },
          { challenge: deletionId(11), operationId: deletionId(10) },
        ]);
        expect(calls('delete-request')).toHaveLength(1);
        expectDeletedOnce();
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 4 — network: 3xx status replies (a redirect the platform did not follow)', () => {
    it('a 307 answering the request arms nothing; a 302 answering the confirmation is UNKNOWN, never deleted, never a second request', async () => {
      let requests = 0;
      route({
        'delete-request': () => {
          requests += 1;
          return requests === 1
            ? reply('delete-request', undefined, 307, {
                headers: { location: 'https://attacker.example/v1/me/x' },
              })
            : reply('delete-request', requestPayload());
        },
        'delete-confirm': () =>
          reply('delete-confirm', completionPayload(), 302, {
            headers: { location: 'https://attacker.example/v1/me/y' },
          }),
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
        expect(allText(renderer)).not.toContain('Deletion status unknown');
        expect(journalRows()).toMatchObject([{ phase: 'request_unknown' }]);
        expectNotDeleted(renderer);

        await pressWhenArmed(renderer, 'Retry request');
        expectArmed(renderer, 10);
        await advance(5_000);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectUnknownOutcome(renderer);
        expect(calls('delete-request')).toHaveLength(2);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 5 — boundary: the device clock rolls back between request and confirmation', () => {
    it('a clock rolled back 10 minutes never sends a confirmation the journal says is not yet reviewable, never claims unknown, keeps the SAME operation armed, and confirms once when time catches up', async () => {
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
        const rolledBackTo = Date.now() - 600_000;
        jest.setSystemTime(rolledBackTo);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));

        expect(calls('delete-confirm')).toHaveLength(0);
        expect(calls('delete-status')).toHaveLength(0);
        const text = allText(renderer);
        expect(text).not.toContain('Deletion status unknown');
        expect(text).not.toContain('may have completed');
        expect(text).not.toContain('Account deleted');
        expect(journalRows()).toMatchObject([
          { operation_id: deletionId(10), phase: 'ready' },
        ]);
        expect(calls('delete-request')).toHaveLength(1);
        expectNotDeleted(renderer);

        // The device clock catches up; the same challenge confirms once.
        jest.setSystemTime(rolledBackTo + 600_000 + 1_000);
        await advance(1_000);
        await pressWhenArmed(renderer, 'Permanently delete');
        expect(calls('delete-confirm').map(bodyOf)).toEqual([
          { challenge: deletionId(11), operationId: deletionId(10) },
        ]);
        expect(calls('delete-request')).toHaveLength(1);
        expectDeletedOnce();
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 6 — boundary: a far-future clock over a sent confirmation, then corrected', () => {
    it('a clock jumped 2 days ahead shows the window closed without asking the server; once corrected, the same operation is re-entered as UNKNOWN and completes only from the receipt', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const first = renderScreen();
      await armDeletion(first);
      await press(first, sheetButton(first, 'Permanently delete'));
      expectUnknownOutcome(first);
      act(() => first.unmount());

      const realNow = Date.now();
      jest.setSystemTime(realNow + 2 * DAY_MS);
      const skewed = renderScreen();
      await openDeleteSheet(skewed);
      const text = allText(skewed);
      expect(text).toContain('Deletion status unknown');
      expect(text).not.toContain("What's making you leave?");
      expect(text).not.toContain('Nothing was deleted');
      expect(sheetButtons(skewed, 'Permanently delete')).toHaveLength(0);
      expect(calls('delete-status')).toHaveLength(0);
      expectNotDeleted(skewed);
      act(() => skewed.unmount());

      jest.setSystemTime(realNow + 60_000);
      const corrected = renderScreen();
      try {
        await openDeleteSheet(corrected);
        expectUnknownOutcome(corrected);
        expect(sheetButtons(corrected, 'Retry deletion')).toHaveLength(1);
        await pressWhenArmed(corrected, 'Retry deletion');
        expect(calls('delete-status')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-request')).toHaveLength(1);
        expectDeletedOnce();
      } finally {
        act(() => corrected.unmount());
      }
    });
  });

  describe('ATTACK 7 — process death while the confirmation is on the wire (file-backed journal, fresh database on relaunch)', () => {
    it('the relaunched app re-enters the SAME operation as UNKNOWN, never as the survey or a second request; the status check says pending → the same challenge is re-armed and confirmed exactly once more', async () => {
      const path = join(mkdtempSync(join(tmpdir(), 'w08-attack-')), 'j.sqlite');
      mockDatabase.close();
      mockDatabase = createSqliteTestDb(path);
      let confirms = 0;
      let statuses = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => {
          confirms += 1;
          return confirms === 1
            ? new Promise<Response>(() => {})
            : reply('delete-confirm', completionPayload());
        },
        'delete-status': () => {
          statuses += 1;
          return reply('delete-status', statusPayload('pending'));
        },
      });
      const before = renderScreen();
      await armDeletion(before);
      await press(before, sheetButton(before, 'Permanently delete'));
      expect(confirms).toBe(1);
      expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);

      // Process death: the screen is gone and the database handle with it.
      act(() => before.unmount());
      mockDatabase.close();
      mockDatabase = createSqliteTestDb(path);
      expect(journalRows()).toMatchObject([
        {
          owner_id: OWNER_A,
          operation_id: deletionId(10),
          phase: 'confirm_pending',
        },
      ]);

      const after = renderScreen();
      try {
        await openDeleteSheet(after);
        expectUnknownOutcome(after);
        expect(allText(after)).not.toContain("What's making you leave?");
        expect(calls('delete-request')).toHaveLength(1);
        expectNotDeleted(after);

        await pressWhenArmed(after, 'Retry deletion');
        expect(statuses).toBe(1);
        expect(bodyOf(calls('delete-status')[0]!)).toEqual({
          operationId: deletionId(10),
        });
        expectArmed(after, 10);

        await pressWhenArmed(after, 'Permanently delete');
        expect(confirms).toBe(2);
        expect(calls('delete-confirm').map(bodyOf)).toEqual([
          { challenge: deletionId(11), operationId: deletionId(10) },
          { challenge: deletionId(11), operationId: deletionId(10) },
        ]);
        expect(calls('delete-request')).toHaveLength(1);
        expectDeletedOnce();
        expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
      } finally {
        act(() => after.unmount());
      }
    });

    it('a relaunch while the REQUEST is on the wire re-enters the same job as request-unknown ("nothing deleted"), and its retry mints no second journal row', async () => {
      const path = join(mkdtempSync(join(tmpdir(), 'w08-attack-')), 'j.sqlite');
      mockDatabase.close();
      mockDatabase = createSqliteTestDb(path);
      let requests = 0;
      route({
        'delete-request': () => {
          requests += 1;
          return requests === 1
            ? new Promise<Response>(() => {})
            : reply('delete-request', requestPayload());
        },
      });
      const before = renderScreen();
      await openReview(before);
      await press(before, sheetButton(before, 'Continue to delete'));
      expect(requests).toBe(1);
      expect(journalRows()).toMatchObject([{ phase: 'request_pending' }]);
      act(() => before.unmount());
      mockDatabase.close();
      mockDatabase = createSqliteTestDb(path);

      const after = renderScreen();
      try {
        await openDeleteSheet(after);
        const text = allText(after);
        expect(text).not.toContain("What's making you leave?");
        expect(text).not.toContain('Deletion status unknown');
        expect(text).toContain('Nothing has been deleted');
        expect(sheetButtons(after, 'Retry request')).toHaveLength(1);
        expectNotDeleted(after);

        await pressWhenArmed(after, 'Retry request');
        expect(requests).toBe(2);
        expectArmed(after, 10);
      } finally {
        act(() => after.unmount());
      }
    });
  });

  describe('ATTACK 8 — replay / duplicate identities', () => {
    it('a 200 "deleted" reply naming ANOTHER operation is UNKNOWN (never deleted); a status "completed" WITHOUT a receipt is still UNKNOWN; only a receipt completes', async () => {
      let statuses = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload(99)),
        'delete-status': () => {
          statuses += 1;
          return statuses === 1
            ? reply('delete-status', {
                state: 'completed',
                completionReceipt: null,
                appleAuthorizationRevocation: 'revoked',
              })
            : reply('delete-status', statusPayload('completed'));
        },
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectUnknownOutcome(renderer);
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);
        expectNotDeleted(renderer);

        await pressWhenArmed(renderer, 'Retry deletion');
        expect(statuses).toBe(1);
        expectUnknownOutcome(renderer);
        expectNotDeleted(renderer);
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);

        await pressWhenArmed(renderer, 'Retry deletion');
        expect(statuses).toBe(2);
        expectDeletedOnce();
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-request')).toHaveLength(1);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it("owner B on the same phone never inherits owner A's unresolved confirmation or capability: B gets the survey, requests under B's bearer, and A's row is untouched", async () => {
      let requests = 0;
      route({
        'delete-request': init => {
          requests += 1;
          expect(headerOf(init, 'Authorization')).toBe(
            requests === 1 ? `Bearer ${BEARER_A}` : `Bearer ${BEARER_B}`,
          );
          return reply('delete-request', requestPayload(requests * 10));
        },
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      });
      const asA = renderScreen();
      await armDeletion(asA);
      await press(asA, sheetButton(asA, 'Permanently delete'));
      expectUnknownOutcome(asA);
      act(() => asA.unmount());
      const rowA = journalRows()[0]!;

      await act(async () => {
        signIn(OWNER_B, BEARER_B, 'apple');
      });
      const asB = renderScreen();
      try {
        await openDeleteSheet(asB);
        const text = allText(asB);
        expect(text).toContain("What's making you leave?");
        expect(text).not.toContain('Deletion status unknown');
        expect(sheetButtons(asB, 'Retry deletion')).toHaveLength(0);
        await press(asB, pressable(asB, 'Skip the survey')[0]!);
        await press(asB, sheetButton(asB, 'Continue to delete'));
        expect(requests).toBe(2);
        const rows = journalRows();
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual(rowA);
        expect(rows[1]).toMatchObject({
          owner_id: OWNER_B,
          operation_id: deletionId(20),
          phase: 'ready',
        });
        expect(calls('delete-status')).toHaveLength(0);
        expectNotDeleted(asB);
      } finally {
        act(() => asB.unmount());
      }
    });
  });

  describe('ATTACK 9 — boundary: the journal is full of COMPLETED deletions (verified receipts)', () => {
    it('after 32 completed deletions on this phone a 33rd account can still request its deletion (the path may never go dark), or at least is not told to "come back after an earlier attempt has expired" — receipts never expire', async () => {
      let requests = 0;
      route({
        'delete-request': () => {
          requests += 1;
          return reply('delete-request', requestPayload(requests * 10));
        },
        'delete-confirm': init => {
          const body = bodyOf(init) as { operationId: string };
          return reply('delete-confirm', {
            ...completionPayload(),
            operationId: body.operationId,
          });
        },
      });
      for (let index = 0; index < JOURNAL_CAPACITY; index += 1) {
        mockShowBrandNotice.mockClear();
        useAuthStore.setState({
          completeAccountDeletion: jest.fn(() => Promise.resolve()),
        });
        await act(async () => {
          signIn(ownerId(index), `session.bearer.${index}`, 'google');
        });
        const renderer = renderScreen();
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectDeletedOnce();
        act(() => renderer.unmount());
        await advance(DAY_MS + 60_000);
      }
      expect(journalRows()).toHaveLength(JOURNAL_CAPACITY);
      expect(journalRows().every(row => row.phase === 'receipt_verified')).toBe(
        true,
      );

      mockShowBrandNotice.mockClear();
      useAuthStore.setState({
        completeAccountDeletion: jest.fn(() => Promise.resolve()),
      });
      await act(async () => {
        signIn(OWNER_A, BEARER_A, 'google');
      });
      const renderer = renderScreen();
      try {
        await openReview(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        const text = allText(renderer);
        // Either the request went out (the path is live) …
        const requested =
          calls('delete-request').length === JOURNAL_CAPACITY + 1;
        if (!requested) {
          // … or the refusal must not promise an expiry that can never come.
          expect(text).not.toContain(
            'come back after an earlier attempt has expired',
          );
          expect(text).not.toContain('unfinished deletion attempts');
        }
        expect(requested).toBe(true);
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(1);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 10 — unauthorised: the status capability is refused', () => {
    it('a 401 on the status check after a lost confirmation stays UNKNOWN — never re-armed, never "nothing deleted", never deleted — and the capability is the only bearer the status call ever carries', async () => {
      let statuses = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': init => {
          statuses += 1;
          expect(headerOf(init, 'Authorization')).toBe(
            `Bearer ${DELETION_CAPABILITY}`,
          );
          expect(headerOf(init, 'Authorization')).not.toContain(BEARER_A);
          return statuses < 3
            ? reply(
                'delete-status',
                { error: { message: 'no' } },
                statuses === 1 ? 401 : 403,
              )
            : reply('delete-status', statusPayload('completed'));
        },
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectUnknownOutcome(renderer);

        await pressWhenArmed(renderer, 'Retry deletion');
        expect(statuses).toBe(1);
        expectUnknownOutcome(renderer);
        expectNotDeleted(renderer);

        await pressWhenArmed(renderer, 'Retry deletion');
        expect(statuses).toBe(2);
        expectUnknownOutcome(renderer);
        expectNotDeleted(renderer);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-request')).toHaveLength(1);

        await pressWhenArmed(renderer, 'Retry deletion');
        expect(statuses).toBe(3);
        expectDeletedOnce();
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 11 — concurrency: a poll lands while the owner closes the sheet, then re-enters', () => {
    it('closing the sheet during "in progress" stops the poll; re-entry resumes the SAME operation, polls once more and completes only from the receipt — no second confirmation, no second request', async () => {
      const statuses = ['in_progress', 'completed'];
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () =>
          reply(
            'delete-confirm',
            { operationId: deletionId(10), state: 'in_progress' },
            202,
            { headers: { 'retry-after': '3' } },
          ),
        'delete-status': () =>
          reply(
            'delete-status',
            statusPayload(statuses.shift() ?? 'completed'),
          ),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(allText(renderer)).toContain('Deletion in progress');
        expect(journalRows()).toMatchObject([{ phase: 'observing' }]);

        // Close while the first poll is still pending.
        await press(renderer, sheetButton(renderer, 'Close'));
        await advance(10_000);
        expect(calls('delete-status')).toHaveLength(0);
        expectNotDeleted(renderer);

        await openDeleteSheet(renderer);
        const text = allText(renderer);
        expect(text).toContain('Deletion in progress');
        expect(text).not.toContain("What's making you leave?");
        expect(text).not.toContain('Delete your account?');
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
        await advance(3_000);
        expect(calls('delete-status')).toHaveLength(1);
        await advance(3_000);
        expect(calls('delete-status')).toHaveLength(2);
        expect(calls('delete-confirm')).toHaveLength(1);
        expect(calls('delete-request')).toHaveLength(1);
        expectDeletedOnce();
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 12 — copy & accessibility of every deletion state', () => {
    const FORBIDDEN = [
      /android/i,
      /google play/i,
      /guest mode/i,
      /live court/i,
      /\bDUPR\b/,
      /swingvision/i,
      /pb vision/i,
      /selkirk/i,
      /joola/i,
      /\d+\s?%/,
      /\bbest\b/i,
      /#1\b/,
      /world[- ]class/i,
    ];

    function expectCleanCopy(renderer: TestRenderer.ReactTestRenderer) {
      const text = allText(renderer);
      for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
      expect(text).not.toMatch(/\.\s*\./);
      expect(
        countMatches(text, /Nothing (?:was|has been) deleted/g),
      ).toBeLessThanOrEqual(1);
      for (const label of buttonLabels(renderer)) {
        expect(label.trim().length).toBeGreaterThan(0);
      }
    }

    it('survey, review, armed, request-unknown, confirm-unknown, in-progress and already-in-progress copy never names a forbidden term, never stacks the "nothing deleted" claim, and every button has a label', async () => {
      let requests = 0;
      let confirms = 0;
      route({
        'delete-request': () => {
          requests += 1;
          if (requests === 1)
            return reply('delete-request', { error: { message: 'x' } }, 503);
          if (requests === 3)
            return reply(
              'delete-request',
              {
                error: {
                  code: 'account.deletion_in_progress',
                  message: 'Account deletion is already confirmed.',
                },
              },
              409,
            );
          return reply('delete-request', requestPayload(requests * 10));
        },
        'delete-confirm': () => {
          confirms += 1;
          return confirms === 1
            ? Promise.reject(new TypeError('Network lost'))
            : reply(
                'delete-confirm',
                { operationId: deletionId(40), state: 'in_progress' },
                202,
                { headers: { 'retry-after': '30' } },
              );
        },
        'delete-status': () => reply('delete-status', statusPayload('expired')),
      });
      const renderer = renderScreen();
      try {
        await press(renderer, pressable(renderer, 'Delete account')[0]!);
        expectCleanCopy(renderer);
        await press(renderer, pressable(renderer, "It's too expensive")[0]!);
        await press(renderer, sheetButton(renderer, 'Next'));
        expectCleanCopy(renderer);
        await press(renderer, pressable(renderer, 'Skip this question')[0]!);
        expectCleanCopy(renderer);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expect(journalRows()).toMatchObject([{ phase: 'request_unknown' }]);
        expectCleanCopy(renderer);
        await pressWhenArmed(renderer, 'Retry request');
        expectArmed(renderer, 20);
        expectCleanCopy(renderer);
        await advance(5_000);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectUnknownOutcome(renderer);
        expectCleanCopy(renderer);
        // The server says the request expired unconfirmed: a known outcome.
        await pressWhenArmed(renderer, 'Retry deletion');
        expect(allText(renderer)).toContain('Nothing was deleted');
        expectCleanCopy(renderer);
        expectNotDeleted(renderer);

        // The next request is refused: a confirmed deletion is in progress.
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expect(requests).toBe(3);
        expect(allText(renderer)).toContain('Deletion in progress');
        expectCleanCopy(renderer);
        await press(renderer, sheetButton(renderer, 'Close'));

        // A fresh request whose confirmation the server holds in progress.
        await advance(60_000);
        await openDeleteSheet(renderer);
        if (allText(renderer).includes("What's making you leave?")) {
          await press(renderer, pressable(renderer, 'Skip the survey')[0]!);
          await press(renderer, sheetButton(renderer, 'Continue to delete'));
        }
        await advance(5_000);
        if (sheetButtons(renderer, 'Permanently delete').length > 0) {
          await pressWhenArmed(renderer, 'Permanently delete');
          expect(allText(renderer)).toContain('Deletion in progress');
          expectCleanCopy(renderer);
        }
        expectNotDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('the outcome that replaces the armed challenge (UNKNOWN / in progress) is announced to assistive technology like the rest of the app (alert role or live region on the status text)', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectUnknownOutcome(renderer);
        const announced = textNodes(renderer).filter(node => {
          const text = [node.props.children].flat().join('');
          const live =
            node.props.accessibilityRole === 'alert' ||
            node.props.accessibilityLiveRegion === 'polite' ||
            node.props.accessibilityLiveRegion === 'assertive' ||
            node.parent?.props.accessibilityLiveRegion === 'polite' ||
            node.parent?.props.accessibilityLiveRegion === 'assertive';
          return (
            live &&
            (text.includes('Deletion status unknown') ||
              text.includes('may have completed'))
          );
        });
        expect(announced.length).toBeGreaterThan(0);
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('ATTACK 13 — corrupt / partial persisted state', () => {
    it("a journal row over a sent confirmation whose Keychain item was replaced by another operation's capability is UNKNOWN (never deleted, never the survey, never a status call with the wrong capability)", async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => Promise.reject(new TypeError('Network lost')),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const first = renderScreen();
      await armDeletion(first);
      await press(first, sheetButton(first, 'Permanently delete'));
      expectUnknownOutcome(first);
      act(() => first.unmount());

      // The Keychain item now describes a different operation's window.
      for (const [service, item] of deletionKeychainStore.entries()) {
        const parsed = JSON.parse(item.password) as Record<string, unknown>;
        if (parsed.statusCapability === DELETION_CAPABILITY) {
          deletionKeychainStore.set(service, {
            ...item,
            password: JSON.stringify({
              ...parsed,
              statusCapability: 'B'.repeat(43),
              statusExpiresAt: iso(2 * DAY_MS),
            }),
          });
        }
      }

      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        const text = allText(second);
        expect(text).toContain('Deletion status unknown');
        expect(text).not.toContain("What's making you leave?");
        expect(text).not.toContain('Nothing was deleted');
        expect(sheetButtons(second, 'Permanently delete')).toHaveLength(0);
        expectNotDeleted(second);
        if (sheetButtons(second, 'Retry deletion').length > 0) {
          await pressWhenArmed(second, 'Retry deletion');
        }
        for (const status of calls('delete-status')) {
          expect(headerOf(status, 'Authorization')).not.toBe(
            `Bearer ${'B'.repeat(43)}`,
          );
        }
        expect(calls('delete-request')).toHaveLength(1);
      } finally {
        act(() => second.unmount());
      }
    });
  });

  describe('ATTACK 14 — boundary: hostile Retry-After values on the confirmation', () => {
    it.each([
      ['garbage', 'abc'],
      ['negative', '-1'],
      ['zero', '0'],
      ['exponent', '1e3'],
      ['huge', '999999999'],
      ['http-date', 'Wed, 21 Oct 2099 07:28:00 GMT'],
    ])(
      'a 429 whose Retry-After is %s (%p) paces the retry by a finite default, never a NaN/negative/century-long countdown, never renders as deleted, never mints a second request',
      async (_label, header) => {
        let confirms = 0;
        route({
          'delete-request': () => reply('delete-request', requestPayload()),
          'delete-confirm': () => {
            confirms += 1;
            return confirms === 1
              ? reply('delete-confirm', { error: { message: 'slow' } }, 429, {
                  headers: { 'retry-after': header },
                })
              : reply('delete-confirm', completionPayload());
          },
          'delete-status': () =>
            reply('delete-status', statusPayload('pending')),
        });
        const renderer = renderScreen();
        try {
          await armDeletion(renderer);
          await press(renderer, sheetButton(renderer, 'Permanently delete'));
          expectNotDeleted(renderer);
          expect(calls('delete-request')).toHaveLength(1);
          const paced = [
            ...sheetButtons(renderer, 'Retry deletion'),
            ...sheetButtons(renderer, 'Permanently delete'),
          ];
          expect(paced).toHaveLength(1);
          const label = String(paced[0]!.props.label);
          expect(label).not.toMatch(/NaN|Infinity|-\d/);
          const match = /\((\d+)\)$/.exec(label);
          expect(match).not.toBeNull();
          const seconds = Number(match![1]);
          expect(seconds).toBeGreaterThan(0);
          expect(seconds).toBeLessThanOrEqual(DAY_MS / 1000);
          const [row] = journalRows();
          const { nextAttemptAtMs } = JSON.parse(String(row!.document)) as {
            nextAttemptAtMs: number;
          };
          expect(nextAttemptAtMs - Date.now()).toBeLessThanOrEqual(DAY_MS);
          expect(nextAttemptAtMs).toBeGreaterThan(Date.now());

          await pressWhenArmed(
            renderer,
            sheetButtons(renderer, 'Retry deletion').length
              ? 'Retry deletion'
              : 'Permanently delete',
          );
          if (confirms === 1) {
            expectArmed(renderer, 10);
            await pressWhenArmed(renderer, 'Permanently delete');
          }
          expect(confirms).toBe(2);
          expect(calls('delete-request')).toHaveLength(1);
          expectDeletedOnce();
        } finally {
          act(() => renderer.unmount());
        }
      },
    );
  });

  describe("ATTACK 15 — the server's own coded refusals on the confirmation", () => {
    it('a 429 account.deletion_too_fast (the server says: reviewed too quickly, nothing done, no Retry-After) never renders as deleted, never mints a second request, and the SAME challenge is confirmed on retry', async () => {
      let confirms = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => {
          confirms += 1;
          return confirms === 1
            ? reply(
                'delete-confirm',
                {
                  error: {
                    code: 'account.deletion_too_fast',
                    message: 'Please review the confirmation before deleting.',
                  },
                },
                429,
              )
            : reply('delete-confirm', completionPayload());
        },
        'delete-status': () => reply('delete-status', statusPayload('pending')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectNotDeleted(renderer);
        expect(calls('delete-request')).toHaveLength(1);
        expect(journalRows()).toHaveLength(1);
        // The server's coded refusal is a KNOWN outcome (nothing was done):
        // the dialog must not tell the user the deletion "may have completed".
        expect(allText(renderer)).not.toContain('may have completed');
        const label = sheetButtons(renderer, 'Retry deletion').length
          ? 'Retry deletion'
          : 'Permanently delete';
        await pressWhenArmed(renderer, label);
        if (confirms === 1) {
          expectArmed(renderer, 10);
          await pressWhenArmed(renderer, 'Permanently delete');
        }
        expect(confirms).toBe(2);
        expect(calls('delete-confirm').map(bodyOf)).toEqual([
          { challenge: deletionId(11), operationId: deletionId(10) },
          { challenge: deletionId(11), operationId: deletionId(10) },
        ]);
        expect(calls('delete-request')).toHaveLength(1);
        expectDeletedOnce();
      } finally {
        act(() => renderer.unmount());
      }
    });

    it('a 403 account.deletion_challenge_invalid on the confirmation (the server also answers this once the user is already gone) is UNKNOWN — never deleted, never "nothing deleted" — and resolves only from the status check: expired → fresh request under a NEW operation; completed → deleted once', async () => {
      let requests = 0;
      let statuses = 0;
      route({
        'delete-request': () => {
          requests += 1;
          return reply('delete-request', requestPayload(requests * 10));
        },
        'delete-confirm': () =>
          reply(
            'delete-confirm',
            {
              error: {
                code: 'account.deletion_challenge_invalid',
                message: 'This deletion was not requested.',
              },
            },
            403,
          ),
        'delete-status': () => {
          statuses += 1;
          return reply(
            'delete-status',
            statusPayload(statuses === 1 ? 'expired' : 'completed'),
          );
        },
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expectUnknownOutcome(renderer);
        expect(journalRows()).toMatchObject([{ phase: 'confirm_pending' }]);

        // Status: expired → a KNOWN "nothing deleted" outcome, stated once,
        // and the fresh request is a NEW operation (the stale row is not reused).
        await pressWhenArmed(renderer, 'Retry deletion');
        expect(calls('delete-status')).toHaveLength(1);
        expectNotDeleted(renderer);
        const text = allText(renderer);
        expect(text).not.toContain('Deletion status unknown');
        expect(countMatches(text, /Nothing (?:was|has been) deleted/g)).toBe(1);
        expect(sheetButtons(renderer, 'Permanently delete')).toHaveLength(0);
        await press(renderer, sheetButton(renderer, 'Continue to delete'));
        expect(requests).toBe(2);
        await advance(5_000);
        expect(allText(renderer)).toContain('Delete your account?');
        expect(
          journalRows().filter(row => row.phase === 'ready'),
        ).toMatchObject([{ operation_id: deletionId(20) }]);
        expect(calls('delete-confirm').map(bodyOf)).toEqual([
          { challenge: deletionId(11), operationId: deletionId(10) },
        ]);

        // Second confirmation: the same 403, but the status check now says
        // completed with a receipt → deleted exactly once, for operation 20.
        await pressWhenArmed(renderer, 'Permanently delete');
        expectUnknownOutcome(renderer);
        await pressWhenArmed(renderer, 'Retry deletion');
        expect(calls('delete-status')).toHaveLength(2);
        expect(bodyOf(calls('delete-status')[1]!)).toEqual({
          operationId: deletionId(20),
        });
        expectDeletedOnce();
      } finally {
        act(() => renderer.unmount());
      }
    });
  });
});
