import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { buildConsistencySnapshot } from '../../../src/consistency/engine';

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

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn() }),
  useFocusEffect: () => {},
}));

// Three straight trained days ending "today" (Jan 15) so the engine awards
// Kindling (streak.3) with earnedOnDay = 2026-01-15. The engine keys days in
// its own zone; the screen must render THAT day key, whatever zone the device
// clock is in. Run this suite under TZ=Pacific/Auckland (UTC+13 in January),
// TZ=Pacific/Kiritimati (UTC+14) and TZ=America/Los_Angeles (UTC-8): every
// label below must equal the engine day in all of them.
const ENGINE_DAY = '2026-01-15';
const mockSnapshot = buildConsistencySnapshot(
  [
    {
      kind: 'stroke',
      atIso: '2026-01-13T10:00:00.000Z',
      shotType: 'dink',
      overallScore: 6.2,
      resultKind: 'scored',
    },
    {
      kind: 'stroke',
      atIso: '2026-01-14T10:00:00.000Z',
      shotType: 'forehand_drive',
      overallScore: 7.4,
      resultKind: 'scored',
    },
    {
      kind: 'stroke',
      atIso: '2026-01-15T10:00:00.000Z',
      shotType: 'serve',
      overallScore: 8.1,
      resultKind: 'scored',
    },
  ],
  { asOfIso: '2026-01-15T18:00:00.000Z', timeZone: 'UTC' },
);
const mockRefresh = jest.fn(async () => undefined);
jest.mock('../../../src/consistency/store', () => ({
  useConsistencyStore: (selector: (state: unknown) => unknown) =>
    selector({ snapshot: mockSnapshot, refresh: mockRefresh }),
}));

import { StreakCalendarScreen } from '../../../src/screens/StreakCalendarScreen';

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<StreakCalendarScreen />);
  });
  return renderer;
}

function dayDetailHeading(renderer: TestRenderer.ReactTestRenderer): string {
  const detail = renderer.root.findAll(
    node => node.props.testID === 'streak-day-detail',
  )[0]!;
  const heading = detail.findAllByType(Text)[0]!;
  return String(heading.props.children);
}

function badgeLabel(
  renderer: TestRenderer.ReactTestRenderer,
  title: string,
): string {
  return renderer.root.findAll(
    node =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith(`${title}.`) &&
      typeof node.props.onPress === 'function',
  )[0]!.props.accessibilityLabel;
}

const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

describe(`calendar labels follow the engine day key (device zone: ${deviceZone})`, () => {
  it('precondition: the engine awarded Kindling on the fixture day', () => {
    expect(mockSnapshot.asOfDay).toBe(ENGINE_DAY);
    expect(mockSnapshot.trainedToday).toBe(true);
    expect(
      mockSnapshot.earned.find(entry => entry.id === 'streak.3')?.earnedOnDay,
    ).toBe(ENGINE_DAY);
  });

  it("Achievements 'Earned <date>' names the engine day", () => {
    const renderer = renderScreen();
    expect(badgeLabel(renderer, 'Kindling')).toBe('Kindling. Earned Jan 15');
    expect(badgeLabel(renderer, 'First Spark')).toBe(
      'First Spark. Earned Jan 13',
    );
    act(() => renderer.unmount());
  });

  it('the auto-selected today detail heading names the engine day', () => {
    const renderer = renderScreen();
    expect(dayDetailHeading(renderer)).toBe('Thursday, January 15');
    act(() => renderer.unmount());
  });

  it('a tapped day detail heading names the tapped cell day key', async () => {
    const renderer = renderScreen();
    const cell = renderer.root.findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('2026-01-14, trained') &&
        typeof node.props.onPress === 'function',
    )[0]!;
    await act(async () => {
      cell.props.onPress();
    });
    expect(dayDetailHeading(renderer)).toBe('Wednesday, January 14');
    act(() => renderer.unmount());
  });
});
