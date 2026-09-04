/**
 * Minimized replay of the long-run-leak campaign failure (seeds 20260904024,
 * 20260904036, 20260904051 in
 * `manageAccountScreen.longRunLeak.stress.test.tsx`).
 *
 * Scenario: the deletion dialog is in `requesting` (POST /v1/me/delete-request
 * in flight) when the screen is unmounted — the route is popped, or the whole
 * navigator tears down. The request then resolves. Expected: the resolved
 * continuation is inert. Observed: `beginRequest` only checks
 * `presentationRef`, which is bumped when `visible` flips to false, not on
 * unmount, so it still runs `setInterval(..., 1000)` for the arming countdown
 * (ManageAccountScreen.tsx:419). The effect cleanup `stopCountdown` already
 * ran at unmount, before the interval existed, so nothing ever clears it: one
 * orphan 1s interval (and the dialog closure it retains) per occurrence, for
 * the life of the process.
 *
 * Deterministic (fake timers, scripted fetch), no seed needed.
 */
import React from 'react';
import { Pressable, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { NavigationContainer } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('sqlite unavailable in the stress harness');
  },
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';

type StackParams = { Launcher: undefined; ManageAccount: undefined };
const Stack = createNativeStackNavigator<StackParams>();

function Launcher(props: NativeStackScreenProps<StackParams, 'Launcher'>) {
  return (
    <Pressable
      accessibilityLabel="Open manage account"
      onPress={() => props.navigation.navigate('ManageAccount')}
    >
      <Text>launcher</Text>
    </Pressable>
  );
}

const flush = () =>
  act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
  });

function pressLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const node = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  )[0];
  if (!node) throw new Error(`no pressable "${label}"`);
  return act(async () => {
    node.props.onPress();
  });
}

function pressButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const node = renderer.root
    .findAllByType(Button)
    .find(
      n => String(n.props.label).startsWith(label) && n.props.disabled !== true,
    );
  if (!node) throw new Error(`no Button "${label}"`);
  return act(async () => {
    node.props.onPress();
  });
}

const realFetch = globalThis.fetch;
let resolveRequest: ((response: Response) => void) | null = null;
let setIntervalSpy: jest.SpyInstance;
let clearIntervalSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
  });
  setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
  clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
  resolveRequest = null;
  globalThis.fetch = jest.fn(
    () =>
      new Promise<Response>(resolve => {
        resolveRequest = resolve;
      }),
  ) as unknown as typeof fetch;
  useAuthStore.setState({
    hydrated: true,
    session: {
      provider: 'google',
      subject: 'google-subject',
      canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
      localOnly: false,
      displayName: 'Alex Chen',
      email: 'alex@example.com',
    },
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  establishApiSession({
    apiBaseUrl: 'https://stress.invalid/functions/v1/api',
    bearerToken: 'stress-bearer',
    canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
    provider: 'google',
  });
});

afterEach(() => {
  setIntervalSpy.mockRestore();
  clearIntervalSpy.mockRestore();
  jest.clearAllTimers();
  jest.useRealTimers();
  globalThis.fetch = realFetch;
  clearApiSession();
  useAuthStore.setState({ session: null });
});

async function mountAndRequest(initialRoute: keyof StackParams) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <NavigationContainer>
        <Stack.Navigator initialRouteName={initialRoute}>
          <Stack.Screen name="Launcher" component={Launcher} />
          <Stack.Screen name="ManageAccount" component={ManageAccountScreen} />
        </Stack.Navigator>
      </NavigationContainer>,
    );
  });
  if (initialRoute === 'Launcher') {
    await pressLabel(renderer, 'Open manage account');
    await flush();
  }
  await pressLabel(renderer, 'Delete account');
  await pressLabel(renderer, 'Skip the survey');
  await pressButton(renderer, 'Continue to delete');
  await flush();
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(resolveRequest).not.toBeNull();
  return renderer;
}

async function settleRequestOk() {
  await act(async () => {
    resolveRequest?.({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          challenge: 'challenge-1',
          expiresAt: '2026-09-04T00:10:00.000Z',
        }),
    } as unknown as Response);
    await new Promise<void>(resolve => setImmediate(resolve));
  });
  await flush();
}

describe('ManageAccountScreen: deletion request resolving after unmount', () => {
  test('control: request resolving while mounted arms the countdown and the interval is cleared on cancel', async () => {
    const renderer = await mountAndRequest('ManageAccount');
    await settleRequestOk();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const countdown: unknown = setIntervalSpy.mock.results[0]?.value;
    expect(clearIntervalSpy).not.toHaveBeenCalledWith(countdown);
    await pressButton(renderer, 'Keep my account');
    expect(clearIntervalSpy).toHaveBeenCalledWith(countdown);
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  test('whole tree unmounted while requesting: resolved request must not start a countdown interval', async () => {
    const renderer = await mountAndRequest('ManageAccount');
    await act(async () => {
      renderer.unmount();
    });
    expect(setIntervalSpy).not.toHaveBeenCalled();

    // Settling clears the request's 15s abort timer; nothing may be added.
    await settleRequestOk();
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('route popped while requesting (screen unmounted, navigator alive): resolved request must not start a countdown interval', async () => {
    const renderer = await mountAndRequest('Launcher');
    await pressLabel(renderer, 'Back');
    await flush();
    expect(renderer.root.findAllByType(ManageAccountScreen)).toHaveLength(0);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    await settleRequestOk();
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(setIntervalSpy).not.toHaveBeenCalled();
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(jest.getTimerCount()).toBe(0);
  });
});
