/**
 * ADVERSARIAL PASS 3 — mobile-settings-account #2 (target 4d812e1a).
 *
 * The real `ManageAccountScreen` + the real `src/account/deletion.ts` client
 * are driven against a scripted fake HTTP server (globalThis.fetch). Nothing
 * in production is mocked except the network, the DB handle, navigation and
 * the auth store's post-deletion cleanup (`completeAccountDeletion`), which
 * is a spy so the tests can tell whether the app ever acknowledged that the
 * server-side account is gone.
 *
 * Scenarios:
 *   S1  delete-confirm hangs past the 15s client deadline (the server DID
 *       delete the account) → retry answers 401 → the user must not be told
 *       to "sign in again" for an account that no longer exists, or the
 *       post-deletion cleanup must run.
 *   S3  challenge armed, clock advanced 15min+1s, confirm tapped → the
 *       client either blocks locally on `expiresAt` or handles the server's
 *       403 `account.deletion_challenge_expired` once, without looping.
 *   S6  open → request → cancel ×4 inside an hour, the 4th request answered
 *       429 + Retry-After → the copy tells the player how long to wait.
 *
 * Each test states in its name whether it HELD or is BROKEN on 4d812e1a so a
 * red test here is a documented finding, not a flake.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('../../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));
jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

import { ManageAccountScreen } from '../../../src/screens/ManageAccountScreen';
import { Button } from '../../../src/design/components';
import { useAuthStore, type AuthSession } from '../../../src/auth/authStore';
import {
  useApiSessionStore,
  type ApiSession,
} from '../../../src/account/apiSession';

const CANONICAL_ID = '11111111-1111-4111-8111-111111111111';
const CHALLENGE_UUID = '33333333-3333-4333-8333-333333333333';
const CLIENT_DEADLINE_MS = 15_000; // deletion.ts post(): AbortController after 15s
const SERVER_CHALLENGE_TTL_MS = 15 * 60_000; // index.ts requestAccountDeletion
const ARM_DELAY_MS = 5_000; // ManageAccountScreen DELETE_ARM_DELAY_MS

const syncedSession: AuthSession = {
  provider: 'google',
  subject: CANONICAL_ID,
  canonicalAppUserId: CANONICAL_ID,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

const apiSession: ApiSession = {
  apiBaseUrl: 'https://api.example.test/functions/v1/api',
  bearerToken: 'access-token',
  canonicalAppUserId: CANONICAL_ID,
  provider: 'google',
};

interface FakeResponseInit {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function fakeResponse(init: FakeResponseInit): Response {
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    statusText: '',
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: async () => init.body,
  } as unknown as Response;
}

type Route = '/v1/me/delete-request' | '/v1/me/delete-confirm';

interface ServerRequest {
  route: Route;
  atMs: number;
  body: unknown;
  bearer: string | null;
}

/**
 * A scripted edge function. Mirrors the server's real semantics where they
 * matter to the client: the challenge row per user, its 15-minute TTL, the
 * 3s minimum age, the per-user delete-request budget (3/hour), and the
 * generic 401 once the auth.users row is gone. Each test can override the
 * confirm handler to model a hang or a slow success.
 */
class FakeDeletionServer {
  readonly requests: ServerRequest[] = [];
  accountDeleted = false;
  challenge: { id: string; createdAtMs: number; expiresAtMs: number } | null =
    null;
  deleteRequestBudget = 3;
  deleteRequestCount = 0;
  /** Server wall clock = phone clock + skew (tests move the phone clock). */
  clockSkewMs = 0;

  now(): number {
    return Date.now() + this.clockSkewMs;
  }
  /** When set, the confirm handler is replaced (S1: hang + delete). */
  confirmOverride:
    ((req: ServerRequest, init: RequestInit) => Promise<Response>) | null =
    null;

  install(): void {
    globalThis.fetch = ((input: string, init?: RequestInit) =>
      this.handle(input, init ?? {})) as unknown as typeof fetch;
  }

  private async handle(input: string, init: RequestInit): Promise<Response> {
    const url = new URL(input);
    const route = url.pathname.replace('/functions/v1/api', '') as Route;
    const headers = init.headers as Record<string, string> | undefined;
    const auth = headers?.Authorization ?? null;
    const req: ServerRequest = {
      route,
      atMs: this.now(),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      bearer: auth ? auth.replace(/^Bearer /, '') : null,
    };
    this.requests.push(req);
    // authenticate(): a deleted user's bearer fails auth.getUser → generic 401.
    if (this.accountDeleted) {
      return fakeResponse({
        status: 401,
        body: {
          error: { message: 'The session is no longer valid. Sign in again.' },
        },
      });
    }
    if (route === '/v1/me/delete-request') return this.deleteRequest(req);
    if (route === '/v1/me/delete-confirm') {
      if (this.confirmOverride) return this.confirmOverride(req, init);
      return this.deleteConfirm(req);
    }
    return fakeResponse({
      status: 404,
      body: { error: { message: 'no route' } },
    });
  }

  private deleteRequest(req: ServerRequest): Response {
    this.deleteRequestCount += 1;
    if (this.deleteRequestCount > this.deleteRequestBudget) {
      // rateLimit.ts rateLimitedResponse(): 429 + Retry-After (seconds left
      // in the aligned 3600s bucket) + the generic body.
      return fakeResponse({
        status: 429,
        headers: { 'Retry-After': '1740' },
        body: {
          error: {
            code: 'rate_limited',
            message:
              'Too many requests. Please slow down and try again shortly.',
          },
        },
      });
    }
    const id = CHALLENGE_UUID.replace(/3$/, String(this.deleteRequestCount));
    this.challenge = {
      id,
      createdAtMs: req.atMs,
      expiresAtMs: req.atMs + SERVER_CHALLENGE_TTL_MS,
    };
    return fakeResponse({
      status: 200,
      body: {
        challenge: id,
        expiresAt: new Date(this.challenge.expiresAtMs).toISOString(),
      },
    });
  }

  deleteConfirm(req: ServerRequest): Response {
    const challenge = (req.body as { challenge?: unknown } | undefined)
      ?.challenge;
    if (!this.challenge || this.challenge.id !== challenge) {
      return fakeResponse({
        status: 403,
        body: {
          error: {
            code: 'account.deletion_challenge_invalid',
            message:
              'This deletion was not requested, or the confirmation does not match. Start again from Settings.',
          },
        },
      });
    }
    if (this.challenge.expiresAtMs <= req.atMs) {
      return fakeResponse({
        status: 403,
        body: {
          error: {
            code: 'account.deletion_challenge_expired',
            message: 'The deletion request expired. Start again from Settings.',
          },
        },
      });
    }
    if (req.atMs - this.challenge.createdAtMs < 3_000) {
      return fakeResponse({
        status: 429,
        body: {
          error: {
            code: 'account.deletion_too_fast',
            message: 'Please review the confirmation before deleting.',
          },
        },
      });
    }
    this.accountDeleted = true;
    return fakeResponse({
      status: 200,
      body: { deleted: true, appleAuthorizationRevocation: 'not_applicable' },
    });
  }
}

let server: FakeDeletionServer;
let renderer: ReactTestRenderer | null = null;
const originalFetch = globalThis.fetch;

function allText(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function pressableByLabel(r: ReactTestRenderer, label: string) {
  const hosts = r.root.findAll(node => {
    if (typeof node.type === 'string') return false;
    const { displayName, name } = node.type as {
      displayName?: string;
      name?: string;
    };
    return (
      (displayName ?? name) === 'Pressable' &&
      node.props.accessibilityLabel === label
    );
  });
  expect(hosts).toHaveLength(1);
  return hosts[0]!;
}

function buttonByPrefix(r: ReactTestRenderer, prefix: string) {
  const matches = r.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(prefix));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function buttonLabels(r: ReactTestRenderer): string[] {
  return r.root.findAllByType(Button).map(node => String(node.props.label));
}

async function tap(node: TestRenderer.ReactTestInstance) {
  await act(async () => {
    node.props.onPress();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function render(): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<ManageAccountScreen />);
  });
  return r;
}

async function openConfirmationPage(r: ReactTestRenderer) {
  await tap(pressableByLabel(r, 'Delete account'));
  expect(allText(r)).toContain("What's making you leave?");
  await tap(pressableByLabel(r, 'Skip the survey'));
  expect(allText(r)).toContain('Delete your account?');
}

/** Continue to delete → server mints the challenge → countdown runs out. */
async function armAndWaitOutCountdown(r: ReactTestRenderer) {
  await tap(buttonByPrefix(r, 'Continue to delete'));
  expect(buttonByPrefix(r, 'Permanently delete').props.label).toBe(
    'Permanently delete (5)',
  );
  await advance(ARM_DELAY_MS);
  expect(buttonByPrefix(r, 'Permanently delete').props.label).toBe(
    'Permanently delete',
  );
  expect(buttonByPrefix(r, 'Permanently delete').props.disabled).toBe(false);
}

const completeAccountDeletion = jest.fn(() => Promise.resolve());

beforeAll(async () => {
  let warmUp!: ReactTestRenderer;
  await act(async () => {
    warmUp = TestRenderer.create(<ManageAccountScreen />);
  });
  act(() => warmUp.unmount());
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
  server = new FakeDeletionServer();
  server.install();
  completeAccountDeletion.mockClear();
  useApiSessionStore.setState({ session: apiSession });
  useAuthStore.setState({
    hydrated: true,
    session: syncedSession,
    busy: false,
    error: null,
    deletionCleanup: null,
    completeAccountDeletion,
  });
});

afterEach(() => {
  if (renderer) {
    const current = renderer;
    act(() => current.unmount());
    renderer = null;
  }
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe('S1 — delete-confirm hangs past the client deadline, then 401 on retry', () => {
  it('the request is aborted at exactly 15s and the retry button is re-armed with retryable copy (HELD)', async () => {
    let confirmSignalAborted = false;
    server.confirmOverride = (_req, init) =>
      new Promise<Response>((_resolve, reject) => {
        // The server received the confirm and completes the deletion; the
        // response simply never reaches the phone.
        server.accountDeleted = true;
        init.signal?.addEventListener('abort', () => {
          confirmSignalAborted = true;
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        });
      });
    renderer = render();
    await openConfirmationPage(renderer);
    await armAndWaitOutCountdown(renderer);

    await tap(buttonByPrefix(renderer, 'Permanently delete'));
    expect(buttonByPrefix(renderer, 'Deleting…').props.disabled).toBe(true);
    await advance(CLIENT_DEADLINE_MS - 1);
    expect(confirmSignalAborted).toBe(false);
    await advance(1);
    expect(confirmSignalAborted).toBe(true);

    expect(allText(renderer)).toContain(
      'Account deletion is temporarily offline. Nothing was deleted — please try again.',
    );
    expect(buttonByPrefix(renderer, 'Permanently delete').props.disabled).toBe(
      false,
    );
    expect(completeAccountDeletion).not.toHaveBeenCalled();
    expect(server.accountDeleted).toBe(true);
  });

  it('[BROKEN on 4d812e1a] after the timed-out confirm the account IS gone; the 401 retry must not say "sign in again" while never running completeAccountDeletion', async () => {
    server.confirmOverride = (_req, init) =>
      new Promise<Response>((_resolve, reject) => {
        server.accountDeleted = true;
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        );
      });
    renderer = render();
    await openConfirmationPage(renderer);
    await armAndWaitOutCountdown(renderer);
    await tap(buttonByPrefix(renderer, 'Permanently delete'));
    await advance(CLIENT_DEADLINE_MS);
    // The phone believes "nothing was deleted" — the server disagrees.
    expect(server.accountDeleted).toBe(true);
    expect(allText(renderer)).toContain('Nothing was deleted');

    // Retry: the bearer now belongs to a deleted user → generic 401.
    server.confirmOverride = null;
    await tap(buttonByPrefix(renderer, 'Permanently delete'));
    await advance(0);
    const confirms = server.requests.filter(
      r => r.route === '/v1/me/delete-confirm',
    );
    expect(confirms).toHaveLength(2);

    const copy = allText(renderer);
    const toldToSignInAgain = /sign in again/i.test(copy);
    const cleanupRan = completeAccountDeletion.mock.calls.length > 0;
    // Acceptable outcomes for a deleted account: the app acknowledges the
    // deletion (cleanup runs) or at least does not send the player off to
    // sign in to an account that no longer exists.
    expect({ toldToSignInAgain, cleanupRan, copy }).toMatchObject({
      toldToSignInAgain: false,
    });
    expect(cleanupRan || !toldToSignInAgain).toBe(true);
  });

  it('a confirm that is merely SLOW (settles at 14.9s) still completes the deletion and runs cleanup (HELD)', async () => {
    server.confirmOverride = req =>
      new Promise<Response>(resolve => {
        setTimeout(() => resolve(server.deleteConfirm(req)), 14_900);
      });
    renderer = render();
    await openConfirmationPage(renderer);
    await armAndWaitOutCountdown(renderer);
    await tap(buttonByPrefix(renderer, 'Permanently delete'));
    await advance(14_900);
    await advance(0);
    expect(server.accountDeleted).toBe(true);
    expect(completeAccountDeletion).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).not.toContain('Delete your account?');
  });
});

describe('S3 — challenge left armed past the server TTL (15 min + 1 s)', () => {
  it('the client never reads expiresAt; the server 403 sends the page back to review ONCE, with no automatic retry, and a fresh request mints a new challenge (HELD via server; no local guard)', async () => {
    renderer = render();
    await openConfirmationPage(renderer);
    await armAndWaitOutCountdown(renderer);
    const confirmsBefore = server.requests.filter(
      r => r.route === '/v1/me/delete-confirm',
    ).length;

    // Phone left on the armed page until the challenge is stale.
    await advance(SERVER_CHALLENGE_TTL_MS - ARM_DELAY_MS + 1_000);
    expect(Date.now()).toBeGreaterThan(server.challenge!.expiresAtMs);
    // No local guard: the button is still enabled and still reads the same.
    const button = buttonByPrefix(renderer, 'Permanently delete');
    expect(button.props.disabled).toBe(false);
    expect(allText(renderer)).not.toMatch(/expired/i);

    await tap(button);
    await advance(0);
    const confirmsAfter = server.requests.filter(
      r => r.route === '/v1/me/delete-confirm',
    );
    expect(confirmsAfter).toHaveLength(confirmsBefore + 1);
    // Server truth: 403 expired → client must not loop on the same challenge.
    expect(allText(renderer)).toContain(
      'The deletion request expired. Start again from Settings.',
    );
    expect(buttonLabels(renderer)).toContain('Continue to delete');
    expect(buttonLabels(renderer)).not.toContain('Permanently delete');
    expect(server.accountDeleted).toBe(false);
    expect(completeAccountDeletion).not.toHaveBeenCalled();

    // Idle a further minute: nothing fires on its own.
    await advance(60_000);
    expect(
      server.requests.filter(r => r.route === '/v1/me/delete-confirm'),
    ).toHaveLength(confirmsBefore + 1);

    // Recovery: Continue to delete mints a NEW challenge; the old one is dead.
    const staleId = server.challenge!.id;
    await tap(buttonByPrefix(renderer, 'Continue to delete'));
    expect(server.challenge!.id).not.toBe(staleId);
    await advance(ARM_DELAY_MS);
    await tap(buttonByPrefix(renderer, 'Permanently delete'));
    await advance(0);
    expect(server.accountDeleted).toBe(true);
    expect(completeAccountDeletion).toHaveBeenCalledTimes(1);
  });

  it('a stale challenge confirmed after the phone clock jumps BACK 20 minutes is still rejected by server time, not trusted by client time (HELD)', async () => {
    renderer = render();
    await openConfirmationPage(renderer);
    await armAndWaitOutCountdown(renderer);
    // Server-side the challenge ages out; the phone clock is skewed back by
    // 20 minutes while the server clock keeps its real time.
    server.challenge!.expiresAtMs = server.now() - 1;
    server.clockSkewMs = 20 * 60_000;
    jest.setSystemTime(Date.now() - 20 * 60_000);
    expect(server.now()).toBeGreaterThan(server.challenge!.expiresAtMs);
    await tap(buttonByPrefix(renderer, 'Permanently delete'));
    await advance(0);
    expect(server.accountDeleted).toBe(false);
    expect(allText(renderer)).toContain('The deletion request expired.');
  });
});

describe('S6 — four request/cancel cycles inside an hour; the 4th is rate-limited', () => {
  async function requestThenKeepAccount(r: ReactTestRenderer) {
    await openConfirmationPage(r);
    await tap(buttonByPrefix(r, 'Continue to delete'));
    await advance(0);
  }

  it('[BROKEN on 4d812e1a] the 429 + Retry-After copy must tell the player how long to wait', async () => {
    renderer = render();
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await requestThenKeepAccount(renderer);
      expect(buttonByPrefix(renderer, 'Permanently delete').props.label).toBe(
        'Permanently delete (5)',
      );
      await tap(buttonByPrefix(renderer, 'Keep my account'));
      expect(allText(renderer)).not.toContain('Delete your account?');
      // Ten minutes between changes of heart: all inside one 3600s bucket.
      await advance(10 * 60_000);
    }
    expect(server.deleteRequestCount).toBe(3);

    await requestThenKeepAccount(renderer);
    expect(server.deleteRequestCount).toBe(4);
    const last = server.requests.at(-1)!;
    expect(last.route).toBe('/v1/me/delete-request');

    const copy = allText(renderer);
    // Back on the review page (no challenge minted), retry is available…
    expect(buttonLabels(renderer)).toContain('Continue to delete');
    expect(buttonByPrefix(renderer, 'Continue to delete').props.disabled).toBe(
      false,
    );
    expect(completeAccountDeletion).not.toHaveBeenCalled();
    // …but the player is told to wait "shortly" while Retry-After said 29 min.
    expect(copy).toContain('Too many requests');
    const mentionsDuration =
      /\b\d+\s*(s|sec|second|seconds|m|min|minute|minutes|h|hour|hours)\b/i.test(
        copy,
      ) || /\b(an hour|one hour|half an hour)\b/i.test(copy);
    expect({ copy, mentionsDuration }).toMatchObject({
      mentionsDuration: true,
    });
  });

  it('the 429 path is classified retryable, nothing was deleted, and no request fires on its own afterwards (HELD)', async () => {
    renderer = render();
    server.deleteRequestBudget = 0;
    await requestThenKeepAccount(renderer);
    expect(server.deleteRequestCount).toBe(1);
    expect(allText(renderer)).toContain('Too many requests');
    expect(buttonLabels(renderer)).toContain('Continue to delete');
    await advance(5 * 60_000);
    expect(server.deleteRequestCount).toBe(1);
    expect(server.accountDeleted).toBe(false);
    expect(completeAccountDeletion).not.toHaveBeenCalled();
  });
});
