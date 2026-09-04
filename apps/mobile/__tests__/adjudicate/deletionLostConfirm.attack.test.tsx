import React from 'react';
import { NativeModules, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';

/**
 * Adversarial variants of MSA-P1-1 / MSA-P2-5 against the fix in eec74a3f.
 *
 * The fix records an unanswered delete-confirm in an in-memory ledger
 * (deletion.ts `unconfirmed`) and turns a later refresh-token refusal into
 * `completeAccountDeletion` (purge + Keychain + provider disconnect +
 * post-deletion notices). These tests probe the edges of that ledger and of
 * the notice logic under the orderings the original repro did not cover:
 *
 *   V1  a GATEWAY 5xx (non-JSON body — the request reached the edge but the
 *       outcome is unknown) is as ambiguous as a client-side timeout, yet the
 *       fix drops the ledger and tells the user "Nothing was deleted";
 *   V2  the ledger is process-local: a relaunch (hydrate) after a lost
 *       confirm turns the refusal back into the plain revoked-session
 *       sign-out — no purge, no notice — i.e. the original P1 symptom
 *       (deleted owner's rows survive) in the background/foreground variant;
 *   V3  a scheduled bearer rotation refused WHILE the confirm is in flight
 *       (the keeper's timer fires inside the 15s window): the store finishes
 *       the deletion first, then the confirm's own answer arrives — a 200
 *       reruns completeAccountDeletion and overwrites `localPurge: 'failed'`
 *       with 'not_needed' (MSA-P2-5's LOCAL CLEANUP notice lost), and a 401
 *       reads the provider from an already-cleared ApiSession, so the Apple
 *       user is never told to check the Apple side.
 *
 * Same harness as deletionLostConfirm.repro.test.tsx: real client, store,
 * keeper and screen; only device seams are faked.
 */

// ─── Device seams ────────────────────────────────────────────────────────────

const mockKv = new Map<string, string>();
const mockStatements: string[] = [];
let mockPurgeFails = false;
function mockCurrentDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      mockStatements.push(statement);
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (statement.startsWith('DELETE FROM') && mockPurgeFails) {
        throw new Error('database is locked');
      }
      return { rows: [] };
    },
    close() {},
  };
}
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(),
    signIn: jest.fn(),
    signInSilently: jest.fn(),
    hasPreviousSignIn: jest.fn(() => false),
    signOut: jest.fn(),
    revokeAccess: jest.fn(),
  },
}));

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.example.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: null,
    googleWebClientId: null,
    appVersion: '1.0',
  }),
}));

jest.mock('../../src/account/deviceContext', () => ({
  getAccountBootstrapEnvironment: () => ({
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    device: {
      platform: 'ios',
      osVersion: '18.5',
      appVersion: '1.0',
      model: 'iOS phone',
    },
  }),
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

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

const mockShowBrandNotice = jest.fn();
jest.mock('../../src/design/BrandNotice', () => ({
  showBrandNotice: (notice: unknown) => mockShowBrandNotice(notice),
}));

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore } from '../../src/auth/authStore';
import {
  clearApiSession,
  getApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  AccountDeletionError,
  confirmAccountDeletion,
  unconfirmedAccountDeletionFor,
} from '../../src/account/deletion';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import * as Keychain from 'react-native-keychain';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

const API = 'https://api.example.test';
const canonicalId = '7fc2c743-028f-4ec6-942c-a84508f3be38';
const CHALLENGE = '3b9d5b3c-6e6a-4a6e-9d1c-0f3d4b7a8e21';

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

/** What the supabase.co gateway returns when the function does not answer
 * in time: a 5xx with a non-JSON body. The function may well have finished
 * `auth.admin.deleteUser` before the gateway gave up on it. */
function gatewayTimeout(): Response {
  return {
    ok: false,
    status: 504,
    json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token <')),
  } as unknown as Response;
}

function bootstrapBody(expiresAt: number) {
  return {
    user: { id: canonicalId, email: 'pat@example.com' },
    onboardingState: 'complete',
    session: {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt,
    },
  };
}

const unauthorized = () =>
  response(
    { error: { code: 'auth.unauthorized', message: 'Unauthorized' } },
    401,
  );

function neverAnswers(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
    );
  });
}

type Route = (init?: RequestInit) => Response | Promise<Response>;

function installRoutes(routes: Record<string, Route | Route[]>): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, handler] of Object.entries(routes)) {
      if (!url.endsWith(suffix)) continue;
      if (Array.isArray(handler)) {
        const next = handler.length > 1 ? handler.shift()! : handler[0]!;
        return next(init);
      }
      return handler(init);
    }
    throw new Error(`network down (${url})`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function vaultRecord(): Record<string, unknown> | null {
  const item = __keychainStore.get(SESSION_VAULT_SERVICE);
  return item ? (JSON.parse(item.password) as Record<string, unknown>) : null;
}

function farFutureSeconds(): number {
  return Math.floor(Date.now() / 1000) + 3600;
}

function apiSessionFixture(): ApiSession {
  return {
    apiBaseUrl: API,
    bearerToken: 'access-1',
    canonicalAppUserId: canonicalId,
    provider: 'apple',
    refreshToken: 'refresh-1',
    bearerExpiresAtMs: farFutureSeconds() * 1000,
  };
}

// ─── Screen helpers ──────────────────────────────────────────────────────────

let mounted: TestRenderer.ReactTestRenderer | null = null;

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ManageAccountScreen />);
  });
  mounted = renderer;
  return renderer;
}

function unmountScreen() {
  if (mounted) {
    const renderer = mounted;
    mounted = null;
    act(() => renderer.unmount());
  }
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
  const matches = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

async function settle(rounds = 60): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
}

async function signInAndArm(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    pressable(renderer, 'Delete account').props.onPress();
  });
  await act(async () => {
    pressable(renderer, 'Skip the survey').props.onPress();
  });
  await act(async () => {
    sheetButton(renderer, 'Continue to delete').props.onPress();
  });
  await settle();
  expect(sheetButton(renderer, 'Permanently delete').props.label).toBe(
    'Permanently delete (5)',
  );
  await act(async () => {
    jest.advanceTimersByTime(5_000);
  });
  const confirm = sheetButton(renderer, 'Permanently delete');
  expect(confirm.props.label).toBe('Permanently delete');
  expect(confirm.props.disabled).toBe(false);
  return confirm;
}

async function signInWithApple(): Promise<void> {
  await useAuthStore.getState().signInWithApple();
  expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(canonicalId);
  expect(getApiSession()?.bearerToken).toBe('access-1');
  expect(vaultRecord()).not.toBeNull();
}

function purgeStatements(): string[] {
  return mockStatements.filter(s => s.startsWith('DELETE FROM'));
}

function notices() {
  return mockShowBrandNotice.mock.calls.map(
    call => call[0] as { title: string; detail: string; eyebrow?: string },
  );
}

const nativeModules = NativeModules as { PickleAuth?: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockKv.clear();
  mockStatements.length = 0;
  mockPurgeFails = false;
  __keychainStore.clear();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setApiUnauthorizedListener(null);
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: true,
    session: null,
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  nativeModules.PickleAuth = {
    signInWithApple: jest.fn().mockResolvedValue({
      user: 'apple-user-opaque',
      identityToken: 'apple-identity-token',
      authorizationCode: 'one-use-apple-code',
      email: 'pat@privaterelay.example',
      givenName: 'Pat',
      familyName: 'Player',
    }),
  };
  installRoutes({});
});

afterEach(() => {
  unmountScreen();
  jest.useRealTimers();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  setApiUnauthorizedListener(null);
  delete nativeModules.PickleAuth;
  globalThis.fetch = realFetch;
});

// ─── V1: a gateway 5xx is as ambiguous as a timeout ──────────────────────────

describe('V1 — delete-confirm answered by the gateway (5xx, non-JSON)', () => {
  async function confirmAnsweredByGateway(): Promise<AccountDeletionError> {
    const apiSession = apiSessionFixture();
    const fetchFn = jest.fn(async () => gatewayTimeout());
    const error = await confirmAccountDeletion(
      apiSession,
      CHALLENGE,
      fetchFn,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountDeletionError);
    return error as AccountDeletionError;
  }

  it('module: a 504 on delete-confirm must keep the challenge recorded as unconfirmed', async () => {
    const error = await confirmAnsweredByGateway();
    // The request reached the edge and the function may have deleted the
    // account before the gateway gave up: same ambiguity as the 15s abort,
    // which keeps the ledger (repro suite). The function's own 5xx carries
    // a JSON error envelope; a bare 5xx is the gateway speaking.
    expect(error.retryable).toBe(true);
    expect(unconfirmedAccountDeletionFor(canonicalId)).toEqual(
      expect.objectContaining({ challenge: CHALLENGE }),
    );
  });

  it('module: a 504 on delete-confirm must not promise "Nothing was deleted"', async () => {
    const error = await confirmAnsweredByGateway();
    expect(error.message).not.toMatch(/nothing was deleted/i);
  });

  it('screen: confirm → 504 → later refresh refused must still finish the deletion locally (purge + notice), like the timeout variant does', async () => {
    jest.useFakeTimers();
    // Bearer expires in 70s → the keeper rotates at +10s.
    const expiresAt = Math.floor(Date.now() / 1000) + 70;
    installRoutes({
      '/v1/account/bootstrap': () => response(bootstrapBody(expiresAt)),
      '/v1/me/delete-request': () =>
        response({ challenge: CHALLENGE, expiresAt: '2026-09-05T00:00:00Z' }),
      '/v1/me/delete-confirm': gatewayTimeout,
      '/v1/auth/refresh': unauthorized,
    });
    await signInWithApple();
    const renderer = renderScreen();
    const confirm = await signInAndArm(renderer);

    await act(async () => {
      confirm.props.onPress();
    });
    await settle();
    // The dialog re-arms; the user does not retry and backs out.
    expect(sheetButton(renderer, 'Permanently delete').props.disabled).toBe(
      false,
    );
    await act(async () => {
      sheetButton(renderer, 'Keep my account').props.onPress();
    });
    await settle();

    // The keeper's scheduled rotation is refused: the account is gone.
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    await settle();

    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(vaultRecord()).toBeNull();
    // A timed-out confirm in the same spot ends with purge + cleanup record
    // (repro suite); the gateway's timeout must not end differently.
    expect(purgeStatements()).toEqual(
      expect.arrayContaining([
        'DELETE FROM local_shot WHERE owner_key = ?',
        'DELETE FROM outbox WHERE owner_key = ?',
      ]),
    );
    expect(state.deletionCleanup).toEqual(
      expect.objectContaining({ localPurge: 'complete' }),
    );
  });
});

// ─── V2: the ledger must survive a relaunch ──────────────────────────────────

describe('V2 — lost confirm, then the app is relaunched', () => {
  it('relaunch (hydrate) after a lost 200: the refused refresh must finish the deletion locally, not merely sign out', async () => {
    jest.useFakeTimers();
    installRoutes({
      '/v1/account/bootstrap': () =>
        response(bootstrapBody(farFutureSeconds())),
      '/v1/me/delete-request': () =>
        response({ challenge: CHALLENGE, expiresAt: '2026-09-05T00:00:00Z' }),
      '/v1/me/delete-confirm': neverAnswers,
      '/v1/auth/refresh': unauthorized,
    });
    await signInWithApple();
    const renderer = renderScreen();
    const confirm = await signInAndArm(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    await settle();
    expect(unconfirmedAccountDeletionFor(canonicalId)).not.toBeNull();
    expect(useAuthStore.getState().session).not.toBeNull();
    unmountScreen();

    // iOS evicts the suspended app; the next launch restores the Keychain
    // record and the server refuses the deleted account's refresh token.
    stopSessionKeeper();
    clearSyncRuntime();
    clearApiSession();
    useAuthStore.setState({ hydrated: false, session: null });
    await act(async () => {
      await useAuthStore.getState().hydrate();
    });
    await settle();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.session).toBeNull();
    expect(vaultRecord()).toBeNull();
    // The account is gone (the ONE way a refresh is refused after a confirm
    // left this phone); the deleted owner's local rows must go with it.
    expect(purgeStatements()).toEqual(
      expect.arrayContaining([
        'DELETE FROM local_shot WHERE owner_key = ?',
        'DELETE FROM outbox WHERE owner_key = ?',
      ]),
    );
    expect(state.deletionCleanup).toEqual(
      expect.objectContaining({ localPurge: 'complete' }),
    );
  });
});

// ─── V3: the keeper answers first, the confirm answers second ────────────────

describe('V3 — bearer rotation refused while the confirm is in flight', () => {
  const FORBIDDEN_COPY =
    /android|google play|guest mode|live court|dupr|\d+\s*%|\bbest\b|swingvision|pb vision|selkirk|joola/i;

  async function rotationRefusedMidConfirm(purgeFails: boolean) {
    jest.useFakeTimers();
    mockPurgeFails = purgeFails;
    let answerConfirm!: (r: Response) => void;
    const expiresAt = Math.floor(Date.now() / 1000) + 70;
    installRoutes({
      '/v1/account/bootstrap': () => response(bootstrapBody(expiresAt)),
      '/v1/me/delete-request': () =>
        response({ challenge: CHALLENGE, expiresAt: '2026-09-05T00:00:00Z' }),
      '/v1/me/delete-confirm': () =>
        new Promise<Response>(resolve => {
          answerConfirm = resolve;
        }),
      '/v1/auth/refresh': unauthorized,
    });
    await signInWithApple();
    const renderer = renderScreen();
    const confirm = await signInAndArm(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    await settle();
    expect(sheetButton(renderer, 'Deleting').props.disabled).toBe(true);

    // The keeper's scheduled rotation fires inside the confirm's window and
    // the server refuses it: the account is already gone. The store ends
    // the account locally (purge attempted) before the confirm answers.
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await settle();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().deletionCleanup).toEqual(
      expect.objectContaining({
        localPurge: purgeFails ? 'failed' : 'complete',
      }),
    );
    return { renderer, answerConfirm: (r: Response) => answerConfirm(r) };
  }

  it('confirm then answers 200 manual_action_required with a FAILED purge → both notices, and localPurge stays failed', async () => {
    const { renderer, answerConfirm } = await rotationRefusedMidConfirm(true);
    await act(async () => {
      answerConfirm(
        response({
          deleted: true,
          appleAuthorizationRevocation: 'manual_action_required',
        }),
      );
    });
    await settle();

    const shown = notices();
    expect(shown.length).toBeGreaterThan(0);
    const text = shown
      .map(n => `${n.eyebrow} ${n.title} ${n.detail}`)
      .join('\n');
    // MSA-P2-5: both outcomes occurred, both must be said.
    expect(text).toContain('Stop Using Apple ID');
    expect(text).toContain('could not be removed');
    expect(text).not.toMatch(FORBIDDEN_COPY);
    // The purge already failed once; a second completeAccountDeletion with
    // no session must not rewrite that to 'not_needed'.
    expect(useAuthStore.getState().deletionCleanup?.localPurge).toBe('failed');
    expect(allText(renderer)).not.toContain('Permanently delete');
  });

  it('confirm then answers 401 for an Apple account → the CHECK APPLE SIGN-IN notice must still be shown', async () => {
    const { renderer, answerConfirm } = await rotationRefusedMidConfirm(false);
    await act(async () => {
      answerConfirm(unauthorized());
    });
    await settle();

    // Same end state as the in-order repro case (lost 200 → retry → 401):
    // an Apple account ended without its revocation outcome is told to
    // check the Apple side.
    expect(useAuthStore.getState().session).toBeNull();
    const shown = notices();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe('Account deleted');
    expect(shown[0]!.detail).toContain('Sign in with Apple');
    expect(shown[0]!.detail).toContain('Stop Using Apple ID');
    expect(allText(renderer)).not.toContain('Permanently delete');
  });
});
