/**
 * Home top-bar streak badge: its 32pt minimum must allow intrinsic large-text
 * height, retain a ≥44pt touch extent, and route into the StreakCalendar.
 * These are rendered layout/prop contracts, not native glyph or hit-test proof.
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
const mockListRealAnalysisFacts = jest.fn<Promise<unknown[]>, unknown[]>(
  async () => [],
);
jest.mock('../../src/data/repository', () => ({
  listShots: (...args: unknown[]) => mockListShots(...args),
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
  getKv: jest.fn(async () => null),
  setKv: jest.fn(async () => {}),
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
  snapshot: null as { currentStreak: number; atRisk: boolean } | null,
  refresh: jest.fn(async () => {}),
};
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (s: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState),
}));

import { Dimensions, Pressable, StyleSheet, Text } from 'react-native';
import { HomeScreen } from '../../src/screens/HomeScreen';

// The renderer exposes the component inside React.memo, not its wrapper.
const PressableInner = (Pressable as unknown as { type: React.ComponentType })
  .type;

const MIN_TOUCH_TARGET_PT = 44;
const initialWindow = Dimensions.get('window');
const initialScreen = Dimensions.get('screen');
const live = new Set<TestRenderer.ReactTestRenderer>();

async function renderHome() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<HomeScreen />);
    live.add(renderer);
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
  const hosts = renderer.root.findAll(
    node => node.props.testID === testID && typeof node.type === 'string',
  );
  expect(hosts).toHaveLength(1);
  return hosts[0]!;
}

function streakPressable(renderer: TestRenderer.ReactTestRenderer) {
  const controls = renderer.root
    .findAllByType(PressableInner)
    .filter(node => node.props.testID === 'home-streak-badge');
  expect(controls).toHaveLength(1);
  return controls[0]!;
}

describe('Home streak badge hit target (wf fix-21)', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockListRealAnalysisFacts.mockClear();
    mockConsistencyState.snapshot = null;
  });
  afterEach(() => {
    act(() => {
      for (const renderer of live) renderer.unmount();
      live.clear();
      Dimensions.set({ window: initialWindow, screen: initialScreen });
    });
  });

  it.each([
    { fontScale: 1, currentStreak: 3 },
    { fontScale: 3.571, currentStreak: 365 },
  ])('intrinsic height and ≥44pt extent ($fontScale)', async fixture => {
    const { fontScale, currentStreak } = fixture;
    const size = { width: 375, height: 667, scale: 2, fontScale };
    Dimensions.set({ window: size, screen: size });
    mockConsistencyState.snapshot = { currentStreak, atRisk: false };
    const renderer = await renderHome();
    const badge = hostPressable(renderer, 'home-streak-badge');
    const style = StyleSheet.flatten(badge.props.style) as {
      height?: number;
      maxHeight?: number;
      minHeight: number;
      minWidth: number;
    };
    const hitSlop = badge.props.hitSlop as number;

    // The host's minimum is a lower bound on its laid-out height. A fixed
    // height or maxHeight would defeat intrinsic growth for larger text.
    expect(style.height).toBe(fontScale > 1.3 ? 'auto' : undefined);
    expect(style.maxHeight).toBeUndefined();
    expect(style.minHeight).toBe(fontScale > 1.3 ? 44 : 32);
    expect(typeof hitSlop).toBe('number');
    expect(style.minHeight + hitSlop * 2).toBeGreaterThanOrEqual(
      MIN_TOUCH_TARGET_PT,
    );
    expect(style.minWidth + hitSlop * 2).toBeGreaterThanOrEqual(
      MIN_TOUCH_TARGET_PT,
    );
    expect(badge.props.accessibilityRole).toBe('button');
    expect(badge.props.accessibilityLabel).toBe(
      `${currentStreak} days training streak. Opens the consistency calendar.`,
    );
    const text = streakPressable(renderer).findByType(Text);
    expect(text.props.children).toBe(currentStreak);
    expect(text.props.numberOfLines).toBeUndefined();
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(text.props.maxFontSizeMultiplier).toBeUndefined();
    act(() => renderer.unmount());
  });

  it.each([
    { currentStreak: 0, dayLabel: 'days' },
    { currentStreak: 1, dayLabel: 'day' },
    { currentStreak: 3, dayLabel: 'days' },
  ])('opens calendar once with $currentStreak $dayLabel', async fixture => {
    const { currentStreak, dayLabel } = fixture;
    mockConsistencyState.snapshot = { currentStreak, atRisk: false };
    const renderer = await renderHome();
    const badge = streakPressable(renderer);
    expect(badge.props.accessibilityRole).toBe('button');
    expect(badge.props.accessibilityLabel).toBe(
      `${currentStreak} ${dayLabel} training streak. Opens the consistency calendar.`,
    );
    expect(badge.findByType(Text).props.children).toBe(currentStreak);
    await act(async () => {
      badge.props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('StreakCalendar');
    act(() => renderer.unmount());
  });

  it('renders the seven-day week card from the real analysis facts read', async () => {
    const renderer = await renderHome();
    expect(mockListRealAnalysisFacts).toHaveBeenCalledTimes(1);
    const texts = renderer.root
      .findAllByType(Text)
      .map(node => String(node.props.children));
    expect(texts.some(text => text.includes('Your court is ready.'))).toBe(
      true,
    );
    act(() => renderer.unmount());
  });
});
