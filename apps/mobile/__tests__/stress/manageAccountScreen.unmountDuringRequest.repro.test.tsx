/**
 * Minimized reproduction of the one BROKEN invariant found by the seeded
 * randomized campaign (`manageAccountScreen.randomizedSeeded.stress.test.tsx`,
 * seed 20260927 and 13 others, ddmin → 5 actions):
 *
 *   tap(Delete account) → tap(Skip the survey) → button(Continue to delete)
 *   → screen pops off the stack while the request is in flight
 *   → the request resolves
 *
 * `DeleteAccountDialog.beginRequest` guards its continuation with
 * `presentationRef`, which is bumped only when `props.visible` flips to
 * false. Unmounting the whole screen (parent pop / reset / `navigate('Tabs')`
 * from a notification press) never flips `visible`, so the continuation
 * passes the guard, calls `setStep` on an unmounted component (dropped) and
 * starts the 1 s countdown `setInterval`. Nothing owns that timer any more:
 * the effect cleanup already ran, and the interval's own `stopCountdown()`
 * lives inside a `setStep` updater React never executes for an unmounted
 * fiber. The interval fires every second for the life of the process.
 *
 * This suite is EXPECTED TO FAIL until ManageAccountScreen.tsx also guards
 * the continuation against unmount (or clears `timerRef` in the cleanup
 * after the request settles). Real navigator + providers; only the SQLite
 * handle and `fetch` are replaced.
 */
import React from 'react';
import { Pressable, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { NavigationContainer, useNavigation } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';

const CANONICAL_ID = '11111111-1111-4111-8111-111111111111';

const syncedSession: AuthSession = {
  provider: 'google',
  subject: CANONICAL_ID,
  canonicalAppUserId: CANONICAL_ID,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

type StackParams = { Host: undefined; ManageAccount: undefined };
const Stack = createNativeStackNavigator<StackParams>();

function HostScreen() {
  const navigation = useNavigation();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open Manage account"
      onPress={() =>
        (navigation as { navigate: (route: 'ManageAccount') => void }).navigate(
          'ManageAccount',
        )
      }
    >
      <Text>Settings host</Text>
    </Pressable>
  );
}

function App() {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, bottom: 34, left: 0, right: 0 },
      }}
    >
      <NavigationContainer>
        <Stack.Navigator initialRouteName="Host">
          <Stack.Screen name="Host" component={HostScreen} />
          <Stack.Screen name="ManageAccount" component={ManageAccountScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

type Renderer = TestRenderer.ReactTestRenderer;

function pressable(renderer: Renderer, label: string) {
  const nodes = renderer.root.findAll(
    node =>
      typeof node.type !== 'string' &&
      ((node.type as { displayName?: string; name?: string }).displayName ??
        (node.type as { name?: string }).name) === 'Pressable' &&
      node.props.accessibilityLabel === label,
  );
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

function button(renderer: Renderer, label: string) {
  const nodes = renderer.root
    .findAllByType(Button)
    .filter(node => node.props.label === label);
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

const flush = () => act(async () => {});

describe('ManageAccountScreen — screen unmounts while the delete request is in flight', () => {
  const liveIntervals = new Map<number, number>();
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    liveIntervals.clear();
    // Wrap the FAKE timers (installed above) so the ledger sees what the
    // screen schedules and jest still owns every timer at teardown.
    const fakeSetInterval = globalThis.setInterval;
    const fakeClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const id = fakeSetInterval(...args) as unknown as number;
      liveIntervals.set(id, Number(args[1] ?? 0));
      return id as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => {
      liveIntervals.delete(id as unknown as number);
      return fakeClearInterval(id);
    }) as typeof clearInterval;
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      deletionCleanup: null,
    });
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'access-token',
      canonicalAppUserId: CANONICAL_ID,
      provider: 'google',
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    clearApiSession();
    jest.useRealTimers();
  });

  it('leaves no countdown interval behind when the request resolves after the pop', async () => {
    let resolveRequest!: (response: Response) => void;
    globalThis.fetch = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          resolveRequest = resolve;
        }),
    ) as unknown as typeof fetch;

    let renderer!: Renderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await flush();
    await act(async () => {
      pressable(renderer, 'Open Manage account').props.onPress();
    });
    await flush();
    await act(async () => {
      pressable(renderer, 'Delete account').props.onPress();
    });
    await flush();
    await act(async () => {
      pressable(renderer, 'Skip the survey').props.onPress();
    });
    await flush();
    await act(async () => {
      button(renderer, 'Continue to delete').props.onPress();
    });
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(button(renderer, 'Requesting…').props.disabled).toBe(true);

    // The parent pops the screen while the request is still in flight.
    await act(async () => {
      pressable(renderer, 'Back').props.onPress();
    });
    await flush();
    expect(
      renderer.root.findAll(
        node => node.props.accessibilityLabel === 'Delete account',
      ),
    ).toHaveLength(0);
    expect([...liveIntervals.values()].filter(ms => ms === 1000)).toHaveLength(
      0,
    );

    await act(async () => {
      resolveRequest({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            challenge: '33333333-3333-4333-8333-333333333333',
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          }),
      } as unknown as Response);
    });
    await flush();
    await flush();

    // It never clears itself either: the interval's stopCountdown() lives in
    // a setStep updater that React does not run for an unmounted component.
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });

    // Invariant: an unmounted dialog owns no timers.
    const countdownIntervals = [...liveIntervals.values()].filter(
      ms => ms === 1000,
    ).length;
    expect(countdownIntervals).toBe(0);

    await act(async () => {
      renderer.unmount();
    });
  });
});
