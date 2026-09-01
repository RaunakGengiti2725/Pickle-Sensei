/**
 * Home top-bar streak badge: the 32pt visual chip must still present a ≥44pt
 * touch target (Apple HIG) and route into the StreakCalendar.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../src/data/db', () => ({
  getDb: jest.fn(() => ({
    execute: jest.fn(async () => ({ rows: [] })),
    close() {},
  })),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = jest.requireActual<typeof import('react')>('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

const mockListShots = jest.fn<Promise<unknown[]>, unknown[]>(async () => []);
const mockListCaptureHistory = jest.fn<Promise<unknown[]>, unknown[]>(
  async () => [],
);
jest.mock('../../src/data/repository', () => ({
  listShots: (...args: unknown[]) => mockListShots(...args),
  listCaptureHistory: (...args: unknown[]) => mockListCaptureHistory(...args),
}));

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));

jest.mock('../../src/progress/api', () => ({
  fetchCanonicalProgress: jest.fn(async () => null),
}));

jest.mock('../../src/components/PlayerRankBanner', () => {
  const { View } = require('react-native');
  return { PlayerRankBanner: () => <View testID="rank-banner-stub" /> };
});

jest.mock('../../src/notifications/NotificationPrimingCard', () => {
  const { View } = require('react-native');
  return { NotificationPrimingCard: () => <View testID="priming-stub" /> };
});

jest.mock('../../src/walkthrough/targets', () => ({
  useWalkthroughTarget: () => ({ current: null }),
}));

jest.mock('../../src/state/appStore', () => ({
  useAppStore: (selector: (s: { profile: null }) => unknown) =>
    selector({ profile: null }),
}));

const mockConsistencyState = {
  snapshot: null as unknown,
  refresh: jest.fn(async () => {}),
};
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (s: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState),
}));

import { StyleSheet, Text } from 'react-native';
import { HomeScreen } from '../../src/screens/HomeScreen';

const MIN_TOUCH_TARGET_PT = 44;

async function renderHome() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<HomeScreen />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return renderer;
}

function hostPressable(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const host = renderer.root
    .findAll(node => node.props.testID === testID)
    .find(node => typeof node.type === 'string');
  if (!host) throw new Error(`No host node for ${testID}`);
  return host;
}

describe('Home streak badge hit target (wf fix-21)', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockListCaptureHistory.mockClear();
  });

  it('extends the 32pt chip to at least a 44pt touch target via hitSlop', async () => {
    const renderer = await renderHome();
    const badge = hostPressable(renderer, 'home-streak-badge');
    const style = StyleSheet.flatten(badge.props.style) as { height: number };
    const hitSlop = badge.props.hitSlop as number;

    expect(style.height).toBe(32);
    expect(typeof hitSlop).toBe('number');
    expect(style.height + hitSlop * 2).toBeGreaterThanOrEqual(
      MIN_TOUCH_TARGET_PT,
    );
    expect(badge.props.accessibilityRole).toBe('button');
    act(() => renderer.unmount());
  });

  it('routes to the StreakCalendar when pressed', async () => {
    const renderer = await renderHome();
    const [badge] = renderer.root.findAll(
      node =>
        node.props.testID === 'home-streak-badge' &&
        typeof node.props.onPress === 'function',
    );
    if (!badge) throw new Error('No pressable home-streak-badge');
    await act(async () => {
      badge.props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('StreakCalendar');
    act(() => renderer.unmount());
  });

  it('renders the seven-day practice card from the capture history read', async () => {
    const renderer = await renderHome();
    expect(mockListCaptureHistory).toHaveBeenCalledTimes(1);
    const texts = renderer.root
      .findAllByType(Text)
      .map(node => String(node.props.children));
    expect(texts.some(text => text.includes('Your court is ready.'))).toBe(
      true,
    );
    act(() => renderer.unmount());
  });
});
