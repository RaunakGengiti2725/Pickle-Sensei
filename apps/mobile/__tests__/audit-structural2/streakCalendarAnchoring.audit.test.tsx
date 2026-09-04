/**
 * Structural audit #2 (pass 1) — StreakCalendar month anchoring.
 *
 * Covers what the existing suite does not: a real store whose snapshot lands
 * AFTER the screen mounts (the anchoring effect), month navigation across a
 * year boundary, an at-risk error surface with no snapshot, and the
 * device-local "today" key when the snapshot is absent.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { create } from 'zustand';
import {
  buildConsistencySnapshot,
  type ConsistencySnapshot,
} from '../../src/consistency/engine';

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
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = require('react') as typeof import('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

type StoreShape = {
  snapshot: ConsistencySnapshot | null;
  loadError: boolean;
  refresh: () => Promise<void>;
};
const mockStore = create<StoreShape>(() => ({
  snapshot: null,
  loadError: false,
  refresh: async () => undefined,
}));
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (selector: (state: StoreShape) => unknown) =>
    mockStore(selector),
}));

import { StreakCalendarScreen } from '../../src/screens/StreakCalendarScreen';

// Streak that spans New Year: Dec 30, Dec 31, Jan 1 (UTC zone in the engine).
const newYearSnapshot = buildConsistencySnapshot(
  [
    {
      kind: 'stroke',
      atIso: '2025-12-30T10:00:00.000Z',
      shotType: 'dink',
      overallScore: 6.2,
      resultKind: 'scored',
    },
    {
      kind: 'stroke',
      atIso: '2025-12-31T10:00:00.000Z',
      shotType: 'serve',
      overallScore: 7.0,
      resultKind: 'scored',
    },
    {
      kind: 'stroke',
      atIso: '2026-01-01T09:00:00.000Z',
      shotType: 'serve',
      overallScore: 8.1,
      resultKind: 'scored',
    },
  ],
  { asOfIso: '2026-01-01T18:00:00.000Z', timeZone: 'UTC' },
);

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

function render() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<StreakCalendarScreen />);
  });
  return renderer;
}

function button(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  )[0]!;
}

beforeEach(() => {
  mockStore.setState({
    snapshot: null,
    loadError: false,
    refresh: async () => undefined,
  });
});

describe('audit: StreakCalendar anchoring', () => {
  it('walks back across a year boundary and marks the trained December days', async () => {
    mockStore.setState({ snapshot: newYearSnapshot });
    const renderer = render();
    expect(allText(renderer)).toContain('January 2026');
    expect(allText(renderer)).toContain('Day 3 secured');
    await act(async () => {
      button(renderer, 'Previous month').props.onPress();
    });
    const copy = allText(renderer);
    expect(copy).toContain('December 2025');
    expect(copy).not.toContain('January 2026');
    const trained = new Set(
      renderer.root
        .findAll(
          node =>
            typeof node.props.accessibilityLabel === 'string' &&
            /^2025-12-\d\d, trained/.test(node.props.accessibilityLabel),
        )
        .map(node => (node.props.accessibilityLabel as string).slice(0, 10)),
    );
    expect([...trained].sort()).toEqual(['2025-12-30', '2025-12-31']);
    // December is the earliest month with history → cannot walk further.
    const previous = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Previous month' &&
        typeof node.props.accessibilityState === 'object',
    )[0]!;
    expect(previous.props.accessibilityState).toMatchObject({ disabled: true });
    act(() => renderer.unmount());
  });

  it('anchors to the snapshot month when the first snapshot lands after mount, and opens today only once', async () => {
    const renderer = render();
    // Before any snapshot the screen keys "today" from the device clock.
    const todayKey = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      year: 'numeric',
      month: 'long',
    }).format(new Date());
    expect(allText(renderer)).toContain(todayKey);

    await act(async () => {
      mockStore.setState({ snapshot: newYearSnapshot });
    });
    let copy = allText(renderer);
    expect(copy).toContain('January 2026');
    expect(copy).toContain('1 ACTIVITY'); // Jan 1 log opened automatically.

    // Deselecting must stick even when a later snapshot arrives.
    const todayCell = renderer.root.findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('2026-01-01, trained') &&
        typeof node.props.onPress === 'function',
    )[0]!;
    await act(async () => {
      todayCell.props.onPress();
    });
    expect(allText(renderer)).not.toContain('1 ACTIVITY');
    await act(async () => {
      mockStore.setState({ snapshot: { ...newYearSnapshot } });
    });
    copy = allText(renderer);
    expect(copy).not.toContain('1 ACTIVITY');
    act(() => renderer.unmount());
  });

  it('a load error with no snapshot shows an honest retry surface, and the retry calls refresh', async () => {
    const refresh = jest.fn(async () => undefined);
    const renderer = render();
    await act(async () => {
      mockStore.setState({ loadError: true, refresh });
    });
    const copy = allText(renderer);
    expect(copy).not.toContain('DAY STREAK');
    expect(copy).toMatch(/could not|couldn.t/i);
    const initialCalls = refresh.mock.calls.length;
    await act(async () => {
      button(renderer, 'Try again').props.onPress();
    });
    expect(refresh.mock.calls.length).toBeGreaterThan(initialCalls);
    act(() => renderer.unmount());
  });
});
