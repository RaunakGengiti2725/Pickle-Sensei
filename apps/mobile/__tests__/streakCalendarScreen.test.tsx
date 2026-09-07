import React from 'react';
import { Dimensions, StyleSheet, Text } from 'react-native';
import { color, type } from '../src/design/tokens';
import TestRenderer, { act } from 'react-test-renderer';
import { buildConsistencySnapshot } from '../src/consistency/engine';

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
  useFocusEffect: () => {},
}));

// Deterministic fixture: three trained days ending "today" (Mar 10, UTC),
// derived through the real engine so screen and engine can never disagree.
const initialSnapshot = buildConsistencySnapshot(
  [
    {
      kind: 'stroke',
      atIso: '2026-03-08T10:00:00.000Z',
      shotType: 'dink',
      overallScore: 6.2,
      resultKind: 'scored',
    },
    {
      kind: 'stroke',
      atIso: '2026-03-09T10:00:00.000Z',
      shotType: 'forehand_drive',
      overallScore: 7.4,
      resultKind: 'scored',
    },
    {
      kind: 'drill',
      atIso: '2026-03-09T11:00:00.000Z',
      label: 'Dink ladder',
    },
    {
      kind: 'stroke',
      atIso: '2026-03-10T09:00:00.000Z',
      shotType: 'serve',
      overallScore: 8.1,
      resultKind: 'scored',
    },
  ],
  { asOfIso: '2026-03-10T18:00:00.000Z', timeZone: 'UTC' },
);
let mockSnapshot: ReturnType<typeof buildConsistencySnapshot> | null =
  initialSnapshot;
let mockLoadError: string | null = null;
// A one-day run on 2026-09-04 keyed by the engine in UTC. Whatever zone the
// test process runs in, the screen must label that key as September 4.
const mockSeptemberSnapshot = buildConsistencySnapshot(
  [
    {
      kind: 'stroke',
      atIso: '2026-09-04T10:00:00.000Z',
      shotType: 'dink',
      overallScore: 7.1,
      resultKind: 'scored',
    },
  ],
  { asOfIso: '2026-09-04T18:00:00.000Z', timeZone: 'UTC' },
);
const mockRefresh = jest.fn(async () => undefined);
const mockStore = {
  get snapshot() {
    return mockSnapshot;
  },
  set snapshot(value: ReturnType<typeof buildConsistencySnapshot> | null) {
    mockSnapshot = value;
  },
};
jest.mock('../src/consistency/store', () => ({
  useConsistencyStore: (selector: (state: unknown) => unknown) =>
    selector({
      snapshot: mockStore.snapshot,
      loadError: mockLoadError,
      refresh: mockRefresh,
    }),
}));

const initialWindow = Dimensions.get('window');
const initialScreen = Dimensions.get('screen');

function setFontScale(fontScale: number) {
  act(() => {
    const size = { width: 375, height: 667, scale: 2, fontScale };
    Dimensions.set({ window: size, screen: size });
  });
}

import { StreakCalendarScreen } from '../src/screens/StreakCalendarScreen';

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<StreakCalendarScreen />);
  });
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

describe('StreakCalendarScreen', () => {
  afterEach(() => {
    mockSnapshot = initialSnapshot;
    mockLoadError = null;
    act(() => {
      Dimensions.set({ window: initialWindow, screen: initialScreen });
    });
    jest.restoreAllMocks();
  });

  it.each([
    [
      'Pacific/Kiritimati',
      '2026-12-31T08:00:00Z',
      '2026-12-31',
      'Thursday, December 31',
    ],
    [
      'Pacific/Auckland',
      '2026-03-07T21:00:00Z',
      '2026-03-08',
      'Sunday, March 8',
    ],
    [
      'Pacific/Auckland',
      '2026-04-05T00:30:00Z',
      '2026-04-05',
      'Sunday, April 5',
    ],
    [
      'Pacific/Chatham',
      '2026-09-26T22:30:00Z',
      '2026-09-27',
      'Sunday, September 27',
    ],
    [
      'America/New_York',
      '2026-03-08T15:00:00Z',
      '2026-03-08',
      'Sunday, March 8',
    ],
    [
      'Pacific/Pago_Pago',
      '2026-01-01T22:30:00Z',
      '2026-01-01',
      'Thursday, January 1',
    ],
  ])(
    'keeps the selected civil date in %s across DST and date-line boundaries',
    (timeZone, atIso, day, label) => {
      mockSnapshot = buildConsistencySnapshot(
        [
          {
            kind: 'stroke',
            atIso,
            shotType: 'dink',
            overallScore: 6.2,
            resultKind: 'scored',
          },
        ],
        { asOfIso: atIso, timeZone },
      );
      // Model the device's default zone without relying on the Jest worker's TZ.
      jest
        .spyOn(Date.prototype, 'toLocaleDateString')
        .mockImplementation(function (this: Date, _locales, options) {
          return new Intl.DateTimeFormat('en-US', {
            timeZone,
            ...options,
          }).format(this);
        });
      expect(mockSnapshot.asOfDay).toBe(day);
      const renderer = renderScreen();
      const detail = renderer.root.findAll(
        node => node.props.testID === 'streak-day-detail',
      )[0]!;
      const heading = detail.findAllByType(Text)[0]!;
      expect(heading.props.children).toBe(label);
      expect(allText(renderer)).toContain('dink');
      act(() => renderer.unmount());
    },
  );

  it.each(['loaded', 'load-error'])(
    'allows the complete Consistency title at largest Dynamic Type in the %s state',
    state => {
      mockGoBack.mockClear();
      setFontScale(3.571);
      if (state === 'load-error') {
        mockSnapshot = null;
        mockLoadError = 'Could not read history';
      }
      const renderer = renderScreen();
      const heading = renderer.root
        .findAllByType(Text)
        .find(node => node.props.children === 'Consistency')!;
      expect(heading.props.numberOfLines).toBeUndefined();
      expect(heading.props.allowFontScaling).not.toBe(false);
      expect(heading.props.maxFontSizeMultiplier).toBeUndefined();
      expect(StyleSheet.flatten(heading.props.style)).toMatchObject(type.h3);
      const back = renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          node.props.accessibilityLabel === 'Back' &&
          typeof node.props.onClick === 'function',
      )[0]!;
      expect(StyleSheet.flatten(back.props.style)).toMatchObject({
        width: 44,
        height: 44,
      });
      act(() => {
        back.props.onClick({
          currentTarget: back,
          target: back,
          nativeEvent: {},
        });
      });
      expect(mockGoBack).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    },
  );

  it('keeps the normal hero design, then gives DAY STREAK the full card width as Dynamic Type grows', () => {
    setFontScale(1);
    const renderer = renderScreen();
    const findHeroCopy = () => {
      const hero = renderer.root.findAll(
        node => node.props.testID === 'streak-hero',
      )[0]!;
      const texts = hero.findAllByType(Text);
      const caption = texts.find(
        node => [node.props.children].flat(3).join('') === 'DAY STREAK',
      )!;
      return { count: texts[0]!, caption };
    };
    const normal = findHeroCopy();
    expect(normal.count.props.children).toBe(3);
    expect(normal.caption.parent).toBe(normal.count.parent);
    expect(StyleSheet.flatten(normal.count.props.style)).toMatchObject({
      ...type.display,
      color: color.onDark,
      fontSize: 56,
      lineHeight: 60,
    });
    expect(StyleSheet.flatten(normal.caption.props.style)).toMatchObject({
      ...type.h3,
      color: color.onDarkMuted,
      letterSpacing: 2,
    });

    // React-test-renderer cannot measure glyphs; this pins the removal of the
    // flame/count column's width constraint, not native word-wrap rendering.
    setFontScale(3.571);
    const large = findHeroCopy();
    expect(large.count.props.children).toBe(3);
    expect(large.caption.parent?.props.testID).toBe('streak-hero');
    expect(large.caption.parent).not.toBe(large.count.parent);
    expect(StyleSheet.flatten(large.caption.props.style)).toMatchObject({
      ...type.h3,
      color: color.onDarkMuted,
      alignSelf: 'stretch',
    });
    expect(large.caption.props.numberOfLines).toBeUndefined();
    for (const text of renderer.root.findAllByType(Text)) {
      expect(text.props.allowFontScaling).not.toBe(false);
      expect(text.props.maxFontSizeMultiplier).toBeUndefined();
    }
    expect(allText(renderer)).toContain('Day 3 secured');
    setFontScale(1);
    const restored = findHeroCopy();
    expect(restored.caption.parent).toBe(restored.count.parent);
    act(() => renderer.unmount());
  });

  it('shows the streak hero, momentum, calendar month, and achievements', () => {
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy).toContain('DAY STREAK');
    expect(copy).toContain('MOMENTUM LEVEL');
    expect(copy).toContain('March 2026');
    expect(copy).toContain('Achievements');
    // The advertising: Century Club stays visible while locked.
    expect(copy).toContain('Century Club');
    expect(copy).toContain('Next reward:');
    // Day 3 secured today → status line reflects it.
    expect(copy).toContain('Day 3 secured');
    expect(copy).toContain(
      'This calendar and Momentum XP use training saved on this device.',
    );
    act(() => renderer.unmount());
  });

  it('opens a tapped day and lists exactly what was trained', async () => {
    const renderer = renderScreen();
    const dayNode = renderer.root.findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('2026-03-09, trained') &&
        typeof node.props.onPress === 'function',
    )[0]!;
    await act(async () => {
      dayNode.props.onPress();
    });
    const copy = allText(renderer);
    expect(copy).toContain('forehand drive');
    expect(copy).toContain('Dink ladder');
    expect(copy).toContain('2 ACTIVITIES');
    // Scored average for the day: one 7.4 analysis → 7.4.
    expect(copy).toContain('AVG 7.4');
    act(() => renderer.unmount());
  });

  it('titles the selected day with the engine day key in every device zone', () => {
    mockStore.snapshot = mockSeptemberSnapshot;
    try {
      expect(mockSeptemberSnapshot.asOfDay).toBe('2026-09-04');
      const renderer = renderScreen();
      // Trained today → today's log opens by itself (tapping would toggle it).
      const dayNode = renderer.root.findAll(
        node =>
          typeof node.props.accessibilityLabel === 'string' &&
          node.props.accessibilityLabel.startsWith('2026-09-04, trained') &&
          typeof node.props.onPress === 'function',
      )[0]!;
      expect(dayNode.props.accessibilityState).toMatchObject({
        selected: true,
      });
      const detail = renderer.root.findAll(
        node => node.props.testID === 'streak-day-detail',
      )[0]!;
      const title = String(detail.findAllByType(Text)[0]!.props.children);
      expect(title).toContain('September 4');
      expect(title).not.toContain('September 5');
      expect(title).not.toContain('September 3');
      act(() => renderer.unmount());
    } finally {
      mockStore.snapshot = mockSnapshot;
    }
  });

  it('never renders a future month and can walk back to history', async () => {
    const renderer = renderScreen();
    const next = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Next month' &&
        typeof node.props.accessibilityState === 'object',
    )[0]!;
    expect(next.props.accessibilityState).toMatchObject({ disabled: true });
    const previous = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Previous month' &&
        typeof node.props.onPress === 'function',
    )[0]!;
    await act(async () => {
      previous.props.onPress();
    });
    expect(allText(renderer)).toContain('February 2026');
    act(() => renderer.unmount());
  });
});
