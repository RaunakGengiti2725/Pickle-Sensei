import React from 'react';
import { Text } from 'react-native';
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
const mockSnapshot = buildConsistencySnapshot(
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
const mockRefresh = jest.fn(async () => undefined);
jest.mock('../src/consistency/store', () => ({
  useConsistencyStore: (selector: (state: unknown) => unknown) =>
    selector({ snapshot: mockSnapshot, refresh: mockRefresh }),
}));

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
