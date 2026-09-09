import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as Keychain from 'react-native-keychain';

/**
 * W08-01 adversarial suite against candidate a51777e2.
 *
 * Every case drives the real ManageAccountScreen over the real SQLite
 * journal, the in-memory Keychain mock and a routed `globalThis.fetch` — the
 * same seams the candidate's own suite uses — and attacks the boundaries the
 * candidate claims to hold:
 *   - a journaled, transport-verified receipt is the deletion proof even
 *     when the Keychain refuses (r6 claim), so a Keychain that is wholly
 *     unavailable at seal time, or whose item is gone after a relaunch, must
 *     still complete rather than say "may have completed" / "contact support";
 *   - an owner change while a verified completion is in flight;
 *   - a server that replays an operation id the journal already holds;
 *   - a row whose identifying SQLite columns (not just its document) are
 *     corrupt must not lock a replacement account out;
 *   - a crash between the Keychain seal and the `receipt_verified` write;
 *   - an out-of-range Retry-After on a refused first confirmation.
 *
 * Tests that FAIL here reproduce confirmed breaks; they are left failing on
 * purpose.
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

const UNREADABLE = 'could not be read';
const WINDOW_CLOSED = 'window for checking this deletion has closed';

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
const realSetGenericPassword = Keychain.setGenericPassword;
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

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string>)[name];
}

interface JournalRow {
  owner_id: string;
  operation_id: string | null;
  phase: string;
  document: string;
}

function journalRows(): JournalRow[] {
  return mockDatabase.native
    .prepare(
      'SELECT owner_id, operation_id, phase, document FROM device_account_deletion_journal ORDER BY rowid',
    )
    .all()
    .map(row => ({
      owner_id: String(row.owner_id),
      operation_id: row.operation_id === null ? null : String(row.operation_id),
      phase: String(row.phase),
      document: String(row.document),
    }));
}

function journalDocument(row: JournalRow): Record<string, unknown> {
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

function completeAccountDeletionMock() {
  return useAuthStore.getState().completeAccountDeletion as jest.Mock;
}

function expectDeleted(renderer: TestRenderer.ReactTestRenderer) {
  expect(completeAccountDeletionMock()).toHaveBeenCalledTimes(1);
  expect(mockShowBrandNotice).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Account deleted' }),
  );
  expect(allText(renderer)).not.toContain('Deletion status unknown');
}

function expectNotDeleted(renderer: TestRenderer.ReactTestRenderer) {
  expect(completeAccountDeletionMock()).not.toHaveBeenCalled();
  expect(mockShowBrandNotice).not.toHaveBeenCalled();
  expect(allText(renderer)).not.toContain('Account deleted');
}

function expectFreshEntry(renderer: TestRenderer.ReactTestRenderer) {
  const text = allText(renderer);
  expect(text).toContain("What's making you leave?");
  expect(text).not.toContain(UNREADABLE);
  expect(text).not.toContain('Deletion status unknown');
  expect(text).not.toContain('may have completed');
  expect(sheetButtons(renderer, 'Retry deletion')).toHaveLength(0);
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

/** The Keychain stops answering at all (reads AND writes throw, the way
 * errSecInteractionNotAllowed / errSecNotAvailable surface) once `down()`
 * is called, and answers again after `heal()`. */
function keychainOutage() {
  let down = false;
  const set = jest
    .spyOn(Keychain, 'setGenericPassword')
    .mockImplementation(async (username, password, options) => {
      if (down) throw new Error('errSecNotAvailable');
      return realSetGenericPassword(username, password, options);
    });
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
    heal: () => {
      down = false;
    },
    restore: () => {
      set.mockRestore();
      get.mockRestore();
    },
  };
}

/** The candidate's own seam: the second Keychain write (the receipt seal)
 * throws once; every other Keychain call is real. */
function refuseReceiptSeal() {
  let writes = 0;
  return jest
    .spyOn(Keychain, 'setGenericPassword')
    .mockImplementation(async (username, password, options) => {
      writes += 1;
      if (writes === 2) throw new Error('errSecInteractionNotAllowed');
      return realSetGenericPassword(username, password, options);
    });
}

describe('W08-01 adversarial: ManageAccount deletion on candidate a51777e2', () => {
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

  describe('A1/A2/A3 — the Keychain is unavailable when a verified receipt arrives', () => {
    it('A1: a confirmation reply verified in place while the Keychain is wholly unavailable is shown as completed on this launch — not "may have completed" with a network hint', async () => {
      const keychain = keychainOutage();
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => {
          // The device loses the Keychain between sending the confirmation
          // and receiving the verified reply (screen locked / protected
          // data unavailable). Nothing the network says depends on it.
          keychain.down();
          return reply('delete-confirm', completionPayload());
        },
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});

        // The receipt reached the journal, verified against the operation.
        expect(calls('delete-confirm')).toHaveLength(1);
        const [row] = journalRows();
        expect(row).toMatchObject({
          owner_id: OWNER_A,
          operation_id: deletionId(10),
          phase: 'receipt_pending',
        });
        expect(journalDocument(row!)).toMatchObject({
          serverState: 'completed',
          receipt: { appleAuthorizationRevocation: 'revoked' },
        });

        // Candidate claim: "durableState() treats a journaled receipt as the
        // completed proof before any phase/status-window mapping".
        const text = allText(renderer);
        expect(text).not.toContain('may have completed');
        expect(text).not.toContain('Check your connection');
        expect(sheetButtons(renderer, 'Retry deletion')).toHaveLength(0);
        expect(calls('delete-status')).toHaveLength(0);
        expectDeleted(renderer);
      } finally {
        act(() => renderer.unmount());
        keychain.restore();
      }
    });

    it('A2: a relaunch whose Keychain item is gone (device restore) over a journaled verified receipt completes from the receipt — never "could not be read… contact support"', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const seal = refuseReceiptSeal();
      const first = renderScreen();
      try {
        await armDeletion(first);
        await press(first, sheetButton(first, 'Permanently delete'));
        await act(async () => {});
        expect(journalRows()).toMatchObject([{ phase: 'receipt_pending' }]);
        expect(journalDocument(journalRows()[0]!)).toMatchObject({
          serverState: 'completed',
          receipt: { completedAt: expect.any(String) },
        });
      } finally {
        act(() => first.unmount());
        seal.mockRestore();
      }
      resetCleanupSpies();

      // THIS_DEVICE_ONLY Keychain items do not come back with a backup
      // restore; the SQLite journal (and its verified receipt) does.
      deletionKeychainStore.clear();
      await advance(60_000);
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        const text = allText(second);
        expect(text).not.toContain(UNREADABLE);
        expect(text).not.toContain('contact support');
        expect(text).not.toContain('may have completed');
        expect(text).not.toContain(WINDOW_CLOSED);
        expect(sheetButtons(second, 'Retry deletion')).toHaveLength(0);
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);
        expectDeleted(second);
        expect(completeAccountDeletionMock()).toHaveBeenCalledWith(
          expect.objectContaining({ ownerKey: OWNER_A }),
        );
      } finally {
        act(() => second.unmount());
      }
    });

    it('A3: once the Keychain answers again, "Retry deletion" over the journaled receipt completes without minting a request or a second confirmation', async () => {
      const keychain = keychainOutage();
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => {
          keychain.down();
          return reply('delete-confirm', completionPayload());
        },
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        await act(async () => {});
        expect(journalRows()).toMatchObject([{ phase: 'receipt_pending' }]);

        if (sheetButtons(renderer, 'Retry deletion').length > 0) {
          // Retrying while the Keychain is still down must not re-send the
          // confirmation or mint a new request.
          await pressWhenArmed(renderer, 'Retry deletion');
          expect(calls('delete-request')).toHaveLength(1);
          expect(calls('delete-confirm')).toHaveLength(1);
          expectNotDeleted(renderer);

          keychain.heal();
          await pressWhenArmed(renderer, 'Retry deletion');
        }
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);
        for (const init of calls('delete-status')) {
          expect(bodyOf(init)).toEqual({ operationId: deletionId(10) });
          expect(headerOf(init, 'Authorization')).toBe(
            `Bearer ${DELETION_CAPABILITY}`,
          );
        }
        expectDeleted(renderer);
        expect(journalRows()).toMatchObject([
          { owner_id: OWNER_A, operation_id: deletionId(10) },
        ]);
        expect(journalDocument(journalRows()[0]!)).toMatchObject({
          serverState: 'completed',
          receipt: { appleAuthorizationRevocation: 'revoked' },
        });
      } finally {
        act(() => renderer.unmount());
        keychain.restore();
      }
    });
  });

  describe('A4 — interleaved account switch while a VERIFIED completion is in flight', () => {
    it('A4: the verified receipt is kept for owner A (never dropped into an unknown outcome), cleanup runs for owner A only, and nothing goes out under owner B', async () => {
      const confirm = deferred<Response>();
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => confirm.promise,
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const renderer = renderScreen();
      try {
        await armDeletion(renderer);
        await press(renderer, sheetButton(renderer, 'Permanently delete'));
        expect(calls('delete-confirm')).toHaveLength(1);

        await act(async () => {
          signIn(OWNER_B, BEARER_B, 'apple');
          confirm.resolve(reply('delete-confirm', completionPayload()));
        });
        await act(async () => {});
        await advance(10_000);

        // Nothing was sent under the replacement account.
        for (const init of [
          ...calls('delete-request'),
          ...calls('delete-confirm'),
        ])
          expect(headerOf(init, 'Authorization')).toBe(`Bearer ${BEARER_A}`);
        expect(calls('delete-request')).toHaveLength(1);
        expect(calls('delete-confirm')).toHaveLength(1);

        // The server deleted owner A and said so in place, bound to the
        // operation: that proof must survive the owner change in the
        // journal, otherwise owner A's data on this phone is never purged
        // (owner A can no longer sign in to resolve it).
        const [row] = journalRows();
        expect(row).toMatchObject({
          owner_id: OWNER_A,
          operation_id: deletionId(10),
        });
        expect(journalDocument(row!)).toMatchObject({
          serverState: 'completed',
          receipt: { appleAuthorizationRevocation: 'revoked' },
        });

        // Owner B is never signed out or told its account was deleted.
        const cleanup = completeAccountDeletionMock();
        for (const [context] of cleanup.mock.calls as [
          { ownerKey: string } | undefined,
        ][]) {
          expect(context?.ownerKey).toBe(OWNER_A);
        }
        expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
          OWNER_B,
        );
        const text = allText(renderer);
        expect(text).not.toContain('Delete your account?');
        expect(text).not.toContain('Keep my account');
        expect(text).not.toContain('Nothing was deleted');
      } finally {
        act(() => renderer.unmount());
      }
    });
  });

  describe('A5 — replayed operation identity from the server', () => {
    it('A5: a fresh request answered with an operation id the journal already holds is never rendered as deleted or as a confirmable challenge, and the earlier row keeps its identity', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload(10)),
        'delete-confirm': () => reply('delete-confirm', completionPayload(10)),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const first = renderScreen();
      try {
        await armDeletion(first);
        expect(journalRows()).toMatchObject([
          { operation_id: deletionId(10), phase: 'ready' },
        ]);
      } finally {
        act(() => first.unmount());
      }
      // The challenge lapses unconfirmed; the owner comes back later and
      // the server (buggy or hostile) hands out operation 10 again.
      await advance(20 * 60_000);
      const second = renderScreen();
      try {
        await openReview(second);
        await press(second, sheetButton(second, 'Continue to delete'));
        await advance(5_000);

        expect(calls('delete-request')).toHaveLength(2);
        expect(calls('delete-confirm')).toHaveLength(0);
        expectNotDeleted(second);
        const text = allText(second);
        expect(text).not.toContain('may have completed');
        expect(text).not.toContain('Deletion status unknown');
        // The replayed identity must not become an armed confirmation.
        expect(
          sheetButtons(second, 'Permanently delete').filter(
            node => node.props.disabled !== true,
          ),
        ).toHaveLength(0);
        // Exactly one row carries operation 10, and it is the original.
        const rows = journalRows();
        expect(
          rows.filter(row => row.operation_id === deletionId(10)),
        ).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          operation_id: deletionId(10),
          phase: 'ready',
        });
        // The owner is told honestly that nothing was deleted and can leave.
        expect(text).toMatch(/Nothing (was|has been) deleted/);
        const dismiss = buttonLabels(second).find(label =>
          /^(Close|Keep my account)$/.test(label),
        );
        expect(dismiss).toBeDefined();
        expect(sheetButton(second, dismiss!).props.disabled).toBe(false);
      } finally {
        act(() => second.unmount());
      }
    });
  });

  describe('A6 — corrupt identifying columns, not just a corrupt document', () => {
    it("A6: owner A's row whose owner_id column is no longer a UUID must not lock owner B out of deleting its own account", async () => {
      const confirm = deferred<Response>();
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => confirm.promise,
      });
      const first = renderScreen();
      try {
        await armDeletion(first);
        await press(first, sheetButton(first, 'Permanently delete'));
        await act(async () => {
          confirm.reject(new TypeError('Network request failed'));
        });
        await act(async () => {});
        expect(journalRows()).toMatchObject([
          { owner_id: OWNER_A, phase: 'confirm_pending' },
        ]);
      } finally {
        act(() => first.unmount());
      }

      // Bit rot in the owner_id column itself: still 36 bytes (the CHECK
      // constraint holds) but no longer a UUID, and no longer matching the
      // document. The document is intact.
      const corruptOwner = 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz';
      const changed = mockDatabase.native
        .prepare(
          'UPDATE device_account_deletion_journal SET owner_id = ? WHERE owner_id = ?',
        )
        .run(corruptOwner, OWNER_A).changes;
      expect(changed).toBe(1);

      mockFetch.mockClear();
      resetCleanupSpies();
      signIn(OWNER_B, BEARER_B, 'apple');
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        expectFreshEntry(second);
        await press(second, pressable(second, 'Skip the survey')[0]!);
        await press(second, sheetButton(second, 'Continue to delete'));
        await act(async () => {});
        expect(calls('delete-request')).toHaveLength(1);
        expect(headerOf(calls('delete-request')[0]!, 'Authorization')).toBe(
          `Bearer ${BEARER_B}`,
        );
        expect(journalRows()).toMatchObject([
          { owner_id: corruptOwner, phase: 'confirm_pending' },
          { owner_id: OWNER_B, operation_id: deletionId(10), phase: 'ready' },
        ]);
      } finally {
        act(() => second.unmount());
      }
    });
  });

  describe('A7 — crash between the Keychain seal and the receipt_verified write', () => {
    it('A7: a relaunch over a receipt_pending row whose Keychain record already carries the receipt completes with no status call and no second confirmation', async () => {
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => reply('delete-confirm', completionPayload()),
        'delete-status': () =>
          reply('delete-status', statusPayload('completed')),
      });
      const first = renderScreen();
      try {
        await armDeletion(first);
        await press(first, sheetButton(first, 'Permanently delete'));
        await act(async () => {});
        expect(journalRows()).toMatchObject([{ phase: 'receipt_verified' }]);
        expectDeleted(first);
      } finally {
        act(() => first.unmount());
      }

      // Rewind the journal to the instant before `receipt_verified` was
      // written: the row (column AND document) says receipt_pending, the
      // Keychain item already holds the sealed receipt.
      const [row] = journalRows();
      const document = journalDocument(row!);
      const rewound = JSON.stringify({ ...document, phase: 'receipt_pending' });
      const changed = mockDatabase.native
        .prepare(
          "UPDATE device_account_deletion_journal SET phase = 'receipt_pending', document = ? WHERE owner_id = ?",
        )
        .run(rewound, OWNER_A).changes;
      expect(changed).toBe(1);
      expect(deletionKeychainStore.size).toBe(1);

      resetCleanupSpies();
      mockFetch.mockClear();
      await advance(30_000);
      const second = renderScreen();
      try {
        await openDeleteSheet(second);
        const text = allText(second);
        expect(text).not.toContain('may have completed');
        expect(text).not.toContain(UNREADABLE);
        expect(text).not.toContain(WINDOW_CLOSED);
        expect(sheetButtons(second, 'Retry deletion')).toHaveLength(0);
        expect(calls('delete-request')).toHaveLength(0);
        expect(calls('delete-confirm')).toHaveLength(0);
        expect(calls('delete-status')).toHaveLength(0);
        expectDeleted(second);
      } finally {
        act(() => second.unmount());
      }
    });
  });

  describe('A8 — out-of-range Retry-After on a refused first confirmation', () => {
    it('A8: a 429 with Retry-After 99999 on the first confirmation never waits longer than the transport cap and never re-sends under a new operation', async () => {
      let confirms = 0;
      route({
        'delete-request': () => reply('delete-request', requestPayload()),
        'delete-confirm': () => {
          confirms += 1;
          return confirms === 1
            ? reply(
                'delete-confirm',
                { error: { message: 'Too many requests' } },
                429,
                { headers: { 'retry-after': '99999' } },
              )
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

        // Whatever paced button the dialog offers, its countdown must stay
        // within the transport's Retry-After cap (86 400 s) — an
        // unparseable header falls back to the 60 s default, not 99 999 s.
        const paced = buttonLabels(renderer)
          .map(label => /\((\d+)\)$/.exec(label))
          .filter((match): match is RegExpExecArray => match !== null)
          .map(match => Number(match[1]));
        expect(paced.length).toBeGreaterThan(0);
        for (const seconds of paced) expect(seconds).toBeLessThanOrEqual(60);

        // The same operation is re-confirmed (or re-checked) — never a new
        // request.
        const label = buttonLabels(renderer).find(candidate =>
          /^(Permanently delete|Retry deletion)/.test(candidate),
        );
        expect(label).toBeDefined();
        await pressWhenArmed(renderer, label!.replace(/ \(\d+\)$/, ''));
        expect(calls('delete-request')).toHaveLength(1);
        for (const init of calls('delete-confirm'))
          expect(bodyOf(init)).toMatchObject({ operationId: deletionId(10) });
      } finally {
        act(() => renderer.unmount());
      }
    });
  });
});
