import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ADVERSARIAL PASS 3 — mobile-settings-account, scenario S1.
 *
 * Mid-switch: `authStore.session` (what ManageAccount RENDERS — name, email,
 * "Signed in with …") and the ACTIVE local data owner still belong to
 * account A, while `getApiSession()` already carries account B's bearer
 * (authStore.signInWith* calls `installApiSession()` for the new account
 * several awaits before `set({ session })`; `bearerTokenFor()` exists
 * precisely because this window is real for long-lived clients).
 *
 * Expected: the deletion flow refuses (`deletion.not_configured` copy
 * "Sign in to a synced account before deleting it.") — or at minimum never
 * puts a delete-request on the wire under a bearer whose canonical id is not
 * the account shown on screen. Assertions encode that; a failure = repro.
 *
 *   cd apps/mobile && npx jest --ci \
 *     __tests__/attack/settingsAccount.s1.midSwitchDeletion.attack.test.tsx
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
  getApiSession,
} from '../../src/account/apiSession';
import {
  getActiveDataOwner,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  AccountDeletionError,
  confirmAccountDeletion,
  requestAccountDeletion,
} from '../../src/account/deletion';

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

const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const API = 'https://api.attack.invalid/functions/v1/api';

const sessionA: AuthSession = {
  provider: 'apple',
  subject: OWNER_A,
  canonicalAppUserId: OWNER_A,
  localOnly: false,
  displayName: 'Account A',
  email: 'a@example.com',
};

interface WireCall {
  url: string;
  authorization: string | null;
  body: string | null;
}

function installFetch(): WireCall[] {
  const calls: WireCall[] = [];
  (globalThis as { fetch: unknown }).fetch = jest.fn(
    async (input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(input),
        authorization: headers.Authorization ?? null,
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return new Response(
        JSON.stringify({ challenge: 'c-b', expiresAt: 'x' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  );
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

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

async function driveToRequest(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    pressable(renderer, 'Delete account')[0]!.props.onPress();
  });
  await act(async () => {
    pressable(renderer, 'Skip the survey')[0]!.props.onPress();
  });
  await act(async () => {
    sheetButton(renderer, 'Continue to delete').props.onPress();
  });
}

describe('S1 — deletion requested while getApiSession() belongs to another account', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    useAuthStore.setState({
      hydrated: true,
      session: sessionA,
      busy: false,
      error: null,
      deletionCleanup: null,
      completeAccountDeletion: jest.fn(() => Promise.resolve()),
    });
    setActiveDataOwner(OWNER_A);
  });
  afterEach(() => {
    unmountAll();
    jest.useRealTimers();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  it('control: no API session at all (bearer revoked) → refused with the not_configured copy, nothing on the wire', async () => {
    clearApiSession();
    const calls = installFetch();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ManageAccountScreen />);
    });
    await driveToRequest(renderer);
    expect(calls).toHaveLength(0);
    expect(allText(renderer)).toContain(
      'Sign in to a synced account before deleting it.',
    );
    act(() => renderer.unmount());
  });

  it('control: API session matches the rendered account → request goes out under A', async () => {
    establishApiSession({
      apiBaseUrl: API,
      bearerToken: 'bearer-A',
      canonicalAppUserId: OWNER_A,
      provider: 'apple',
    });
    const calls = installFetch();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ManageAccountScreen />);
    });
    await driveToRequest(renderer);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toBe('Bearer bearer-A');
    act(() => renderer.unmount());
  });

  it('ATTACK (screen): api session = B while screen + data owner = A → must refuse, never send under B', async () => {
    establishApiSession({
      apiBaseUrl: API,
      bearerToken: 'bearer-B',
      canonicalAppUserId: OWNER_B,
      provider: 'google',
    });
    // Precondition: the mismatch really exists.
    expect(getApiSession()?.canonicalAppUserId).toBe(OWNER_B);
    expect(getActiveDataOwner()).toBe(OWNER_A);
    expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(OWNER_A);

    const calls = installFetch();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = mount(<ManageAccountScreen />);
    });
    // The screen shows account A's identity…
    expect(allText(renderer)).toContain('a@example.com');
    await driveToRequest(renderer);
    console.info(
      '[attack s1] wire calls:',
      JSON.stringify(
        calls.map(c => ({
          path: c.url.replace(API, ''),
          authorization: c.authorization,
        })),
      ),
    );
    const underB = calls.filter(c => c.authorization === 'Bearer bearer-B');
    expect(underB).toHaveLength(0);
    expect(allText(renderer)).toContain(
      'Sign in to a synced account before deleting it.',
    );
    act(() => renderer.unmount());
  });

  it('ATTACK (module): requestAccountDeletion(getApiSession()) with owner mismatch throws deletion.not_configured', async () => {
    establishApiSession({
      apiBaseUrl: API,
      bearerToken: 'bearer-B',
      canonicalAppUserId: OWNER_B,
      provider: 'google',
    });
    const calls = installFetch();
    let thrown: unknown = null;
    try {
      await requestAccountDeletion(getApiSession(), null);
    } catch (e) {
      thrown = e;
    }
    expect(calls).toHaveLength(0);
    expect(thrown).toBeInstanceOf(AccountDeletionError);
    expect((thrown as AccountDeletionError).code).toBe(
      'deletion.not_configured',
    );
  });

  it('ATTACK (module): confirmAccountDeletion with a challenge minted for A but the current bearer is B is refused', async () => {
    establishApiSession({
      apiBaseUrl: API,
      bearerToken: 'bearer-B',
      canonicalAppUserId: OWNER_B,
      provider: 'google',
    });
    const calls = installFetch();
    let thrown: unknown = null;
    try {
      await confirmAccountDeletion(getApiSession(), 'challenge-minted-for-A');
    } catch (e) {
      thrown = e;
    }
    expect(
      calls.filter(c => c.authorization === 'Bearer bearer-B'),
    ).toHaveLength(0);
    expect(thrown).toBeInstanceOf(AccountDeletionError);
  });
});
