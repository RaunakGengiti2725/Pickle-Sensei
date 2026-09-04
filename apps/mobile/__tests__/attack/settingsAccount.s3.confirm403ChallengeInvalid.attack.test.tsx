import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ADVERSARIAL PASS 3 — mobile-settings-account, scenario S3.
 *
 * The REAL `src/account/deletion.ts` runs against a scripted `fetch`. Flow:
 * request → 200 challenge → confirm #1 fails retryably (503 / network) → the
 * dialog stays armed → confirm #2 (the retry) is answered by the edge
 * function's `403 account.deletion_challenge_invalid`. Expected: the dialog
 * falls back to the review step (no stale challenge kept for a third try),
 * shows the server's message verbatim, and never claims "Nothing was
 * deleted" for a CONFIRM failure — the client cannot know that (the
 * request reached the server; only the answer is missing).
 *
 *   cd apps/mobile && npx jest --ci \
 *     __tests__/attack/settingsAccount.s3.confirm403ChallengeInvalid.attack.test.tsx
 */

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
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

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';

/** Every renderer is unmounted in afterEach so a failed assertion cannot
 * leave a subscribed screen alive past the test (store updates in the next
 * test would re-render it after teardown). */
const mounted: TestRenderer.ReactTestRenderer[] = [];
function mount(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  const renderer = TestRenderer.create(element);
  mounted.push(renderer);
  return renderer;
}
function unmountAll(): void {
  for (const renderer of mounted.splice(0)) {
    try {
      act(() => renderer.unmount());
    } catch {
      // already unmounted by the test
    }
  }
}

const OWNER = '33333333-3333-4333-8333-333333333333';
const API = 'https://api.attack.invalid/functions/v1/api';

const session: AuthSession = {
  provider: 'google',
  subject: OWNER,
  canonicalAppUserId: OWNER,
  localOnly: false,
  displayName: 'Jordan Lee',
  email: 'jordan@example.com',
};

type Script = Array<
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'text'; status: number; body: string }
  | { kind: 'reject'; error: Error }
>;

interface WireCall {
  url: string;
  authorization: string | null;
  body: string | null;
}

function installFetch(script: Script): WireCall[] {
  const calls: WireCall[] = [];
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      authorization: headers.Authorization ?? null,
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const next = script.shift();
    if (!next) throw new Error('fetch script exhausted');
    if (next.kind === 'reject') throw next.error;
    if (next.kind === 'text') {
      return new Response(next.body, {
        status: next.status,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  return calls;
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

function buttons(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = buttons(renderer, label);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

const SERVER_403 = {
  error: {
    code: 'account.deletion_challenge_invalid',
    message:
      'This deletion was not requested, or the confirmation does not match. Start again from Settings.',
  },
};

async function armDialog(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    pressable(renderer, 'Delete account')[0]!.props.onPress();
  });
  await act(async () => {
    pressable(renderer, 'Skip the survey')[0]!.props.onPress();
  });
  await act(async () => {
    sheetButton(renderer, 'Continue to delete').props.onPress();
  });
  await act(async () => {
    jest.advanceTimersByTime(5_000);
  });
  const confirm = sheetButton(renderer, 'Permanently delete');
  expect(confirm.props.disabled).toBe(false);
  return confirm;
}

describe('S3 — confirm retry answered 403 account.deletion_challenge_invalid', () => {
  const realFetch = globalThis.fetch;
  const completeAccountDeletion = jest.fn(() => Promise.resolve());

  beforeEach(() => {
    jest.useFakeTimers();
    completeAccountDeletion.mockClear();
    establishApiSession({
      apiBaseUrl: API,
      bearerToken: 'bearer-owner',
      canonicalAppUserId: OWNER,
      provider: 'google',
    });
    useAuthStore.setState({
      hydrated: true,
      session,
      busy: false,
      error: null,
      deletionCleanup: null,
      completeAccountDeletion,
    });
  });
  afterEach(() => {
    unmountAll();
    jest.useRealTimers();
    clearApiSession();
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  it('503 on confirm #1 keeps the dialog ARMED with the same challenge (retry offered)', async () => {
    const calls = installFetch([
      { kind: 'json', status: 200, body: { challenge: 'c-1', expiresAt: 'x' } },
      {
        kind: 'json',
        status: 503,
        body: {
          error: {
            code: 'service_unavailable',
            message: 'Account deletion is temporarily unavailable.',
          },
        },
      },
    ]);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ManageAccountScreen />);
    });
    const confirm = await armDialog(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    expect(calls.map(c => c.url.split('/').pop())).toEqual([
      'delete-request',
      'delete-confirm',
    ]);
    // Still armed, retry immediately possible.
    expect(sheetButton(renderer, 'Permanently delete').props.disabled).toBe(
      false,
    );
    expect(allText(renderer)).toContain('temporarily unavailable');
    expect(completeAccountDeletion).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('retry → 403 challenge_invalid: back to REVIEW, server copy shown, no "Nothing was deleted" promise, no stale challenge', async () => {
    const calls = installFetch([
      { kind: 'json', status: 200, body: { challenge: 'c-1', expiresAt: 'x' } },
      {
        kind: 'json',
        status: 503,
        body: {
          error: {
            code: 'service_unavailable',
            message: 'Account deletion is temporarily unavailable.',
          },
        },
      },
      { kind: 'json', status: 403, body: SERVER_403 },
      // A subsequent "Continue to delete" must mint a NEW challenge:
      { kind: 'json', status: 200, body: { challenge: 'c-2', expiresAt: 'x' } },
    ]);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ManageAccountScreen />);
    });
    const confirm = await armDialog(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    await act(async () => {
      sheetButton(renderer, 'Permanently delete').props.onPress();
    });
    expect(JSON.parse(calls[2]!.body ?? '{}')).toEqual({ challenge: 'c-1' });

    // Back on review: the challenge button is gone, the review CTA is back.
    expect(buttons(renderer, 'Permanently delete')).toHaveLength(0);
    expect(buttons(renderer, 'Continue to delete')).toHaveLength(1);
    const copy = allText(renderer);
    expect(copy).toContain(SERVER_403.error.message);
    expect(copy).not.toContain('Nothing was deleted');
    expect(completeAccountDeletion).not.toHaveBeenCalled();

    // Stale challenge must not be reused: Continue mints a fresh one.
    await act(async () => {
      sheetButton(renderer, 'Continue to delete').props.onPress();
    });
    expect(calls).toHaveLength(4);
    expect(calls[3]!.url.endsWith('/v1/me/delete-request')).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(sheetButton(renderer, 'Permanently delete').props.disabled).toBe(
      false,
    );
    act(() => renderer.unmount());
  });

  it('403 with NO JSON message body still leaves review and does not promise "Nothing was deleted" on a confirm failure', async () => {
    installFetch([
      { kind: 'json', status: 200, body: { challenge: 'c-1', expiresAt: 'x' } },
      { kind: 'text', status: 403, body: '<html>forbidden</html>' },
    ]);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ManageAccountScreen />);
    });
    const confirm = await armDialog(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    expect(buttons(renderer, 'Permanently delete')).toHaveLength(0);
    const copy = allText(renderer);
    // deletion.ts:148 is the request-step fallback; on the CONFIRM step the
    // client does not know whether the server acted.
    expect(copy).not.toContain('Nothing was deleted');
    act(() => renderer.unmount());
  });

  it('confirm times out / network drops AFTER the request went out: copy must not assert "Nothing was deleted"', async () => {
    installFetch([
      { kind: 'json', status: 200, body: { challenge: 'c-1', expiresAt: 'x' } },
      { kind: 'reject', error: new Error('Network request failed') },
    ]);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ManageAccountScreen />);
    });
    const confirm = await armDialog(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    // Retryable → stays armed with the same challenge (fine: the server
    // treats an already-deleted user as 401, which then reads correctly).
    expect(sheetButton(renderer, 'Permanently delete').props.disabled).toBe(
      false,
    );
    const copy = allText(renderer);
    console.info(
      '[attack s3] confirm network-failure copy:',
      copy.match(/[^.]*Nothing was deleted[^.]*\./)?.[0] ?? '(no promise)',
    );
    expect(copy).not.toContain('Nothing was deleted');
    act(() => renderer.unmount());
  });

  it('while confirm is in flight the button is disabled ("Deleting…") so a second tap cannot send a second confirm', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => {
      release = resolve;
    });
    const calls: WireCall[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn(
      async (input: unknown, init?: RequestInit) => {
        calls.push({
          url: String(input),
          authorization: null,
          body: typeof init?.body === 'string' ? init.body : null,
        });
        if (String(input).endsWith('/v1/me/delete-request')) {
          return new Response(
            JSON.stringify({ challenge: 'c-1', expiresAt: 'x' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return pending;
      },
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ManageAccountScreen />);
    });
    const confirm = await armDialog(renderer);
    await act(async () => {
      confirm.props.onPress();
    });
    // Re-rendered state after the first tap: a second real tap hits a
    // disabled control (Pressable drops onPress when disabled).
    const inFlight = sheetButton(renderer, 'Deleting');
    expect(inFlight.props.disabled).toBe(true);
    expect(buttons(renderer, 'Permanently delete')).toHaveLength(0);
    // Even invoking the re-rendered handler directly is a no-op: the step is
    // 'deleting', not 'armed'.
    await act(async () => {
      inFlight.props.onPress();
    });
    expect(
      calls.filter(c => c.url.endsWith('/v1/me/delete-confirm')),
    ).toHaveLength(1);
    await act(async () => {
      release(
        new Response(JSON.stringify(SERVER_403), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    expect(buttons(renderer, 'Continue to delete')).toHaveLength(1);
    act(() => renderer.unmount());
  });
});
