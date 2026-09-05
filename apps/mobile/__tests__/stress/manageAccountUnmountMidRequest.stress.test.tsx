import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * STRESS scr-manageaccountscreen / lifecycle — minimized reproduction of the
 * campaign finding (seeds 7029, 7072, 7092, 7095 in
 * manageAccountLifecycle.stress.test.tsx): unmounting ManageAccountScreen
 * while the step-1 deletion request is in flight leaks the 1s arm-countdown
 * interval when that request later succeeds.
 *
 * Mechanism (src/screens/ManageAccountScreen.tsx): `presentationRef` is only
 * bumped when the dialog's `visible` prop turns false — an unmount of the
 * whole screen (navigation `back`, navigator remount, sign-out swapping the
 * stack) never bumps it. `beginRequest`'s continuation therefore passes the
 * staleness check at :416, then :419 installs `setInterval(…, 1_000)` on a
 * component that no longer exists. The effect cleanup (`return stopCountdown`
 * at :353) already ran before the interval existed, so nothing ever clears
 * it: it fires once a second for the life of the JS process, calling
 * `setStep` on an unmounted component (a no-op in React 19, so the leak is
 * silent).
 *
 * The screen is rendered exactly like the existing unit suite
 * (__tests__/manageAccountScreen.test.tsx) — real dialog, real state
 * machine; only the two network calls are stubbed so the request can be
 * held open across the unmount.
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

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
}));

type Challenge = { challenge: string; expiresAt: string };
const pendingRequests: Array<(value: Challenge) => void> = [];
jest.mock('../../src/account/deletion', () => {
  const actual = jest.requireActual<
    typeof import('../../src/account/deletion')
  >('../../src/account/deletion');
  return {
    ...actual,
    requestAccountDeletion: () =>
      new Promise<Challenge>(resolve => {
        pendingRequests.push(resolve);
      }),
    confirmAccountDeletion: () => new Promise<never>(() => undefined),
  };
});

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';

const syncedSession: AuthSession = {
  provider: 'apple',
  subject: '7fc2c743-028f-4ec6-942c-a84508f3be38',
  canonicalAppUserId: '7fc2c743-028f-4ec6-942c-a84508f3be38',
  localOnly: false,
  displayName: 'Stress Tester',
  email: 'stress@example.com',
};

function pressLabelled(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const node = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  )[0];
  if (!node) throw new Error(`no pressable "${label}"`);
  node.props.onPress();
}

function pressSheetButton(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const node = renderer.root
    .findAllByType(Button)
    .find(n => String(n.props.label).startsWith(label));
  if (!node) throw new Error(`no sheet button "${label}"`);
  node.props.onPress();
}

/** Drive the real screen to `requesting`, with the request held open. */
async function mountAndStartRequest(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ManageAccountScreen />);
  });
  await act(async () => pressLabelled(renderer, 'Delete account'));
  await act(async () => pressLabelled(renderer, 'Skip the survey'));
  await act(async () => pressSheetButton(renderer, 'Continue to delete'));
  expect(pendingRequests).toHaveLength(1);
  return renderer;
}

describe('ManageAccountScreen — unmount while the deletion request is in flight', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    pendingRequests.length = 0;
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      completeAccountDeletion: jest.fn(() => Promise.resolve()),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('control: closing the dialog first (visible=false) leaves no timer behind', async () => {
    const renderer = await mountAndStartRequest();
    const baseline = jest.getTimerCount();
    await act(async () => pressLabelled(renderer, 'Keep my account'));
    await act(async () => {
      pendingRequests[0]!({
        challenge: 'ch-1',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    });
    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });
    // The close bumped presentationRef, so the late success was dropped.
    expect(jest.getTimerCount()).toBeLessThanOrEqual(baseline);
    act(() => renderer.unmount());
  });

  // `it.failing`: this asserts the CORRECT behaviour (no timer survives the
  // unmount) and is expected to fail on the current code. Once the
  // continuation is cancelled on unmount, this test starts passing, Jest
  // reports the `.failing` as an error, and the marker should be removed.
  it.failing(
    'BROKEN: unmounting mid-request, then the request succeeding, leaks the 1s countdown interval',
    async () => {
      const renderer = await mountAndStartRequest();
      act(() => renderer.unmount());
      // Let the unmount's own one-shot timers (animations, keyboard) drain
      // so the count below isolates what the late response adds.
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      const afterUnmount = jest.getTimerCount();
      const intervalsSet = jest.spyOn(global, 'setInterval');
      const intervalsCleared = jest.spyOn(global, 'clearInterval');

      await act(async () => {
        pendingRequests[0]!({
          challenge: 'ch-1',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
      });
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });

      // Observed on 1fb0efd7 (and origin/main): one setInterval (the arm
      // countdown at ManageAccountScreen.tsx:419), zero clearInterval, and
      // the timer still pending a minute later — nothing on the unmounted
      // tree can clear it.
      expect({
        intervalsSet: intervalsSet.mock.calls.length,
        intervalsCleared: intervalsCleared.mock.calls.length,
        pendingTimersAdded: jest.getTimerCount() - afterUnmount,
      }).toEqual({
        intervalsSet: 0,
        intervalsCleared: 0,
        pendingTimersAdded: 0,
      });
    },
  );
});
