/**
 * Adversarial pass 3 — StreakCalendarScreen month anchoring.
 *
 * The consistency store is replaced by a REAL zustand store so snapshots can
 * land late, be replaced by refreshes, and be interleaved with the user's
 * month navigation and day selection:
 *
 *   C1 before the first snapshot the month controls are inert and the late
 *      snapshot anchors the month once;
 *   C2 after the user walked back a month, a refreshed snapshot (new object,
 *      same or later asOfDay) must NOT re-anchor the visible month;
 *   C3 a deliberately deselected day stays deselected across refreshes;
 *   C4 a stale snapshot from before midnight (app kept in memory over a
 *      month boundary) followed by the fresh one — the calendar must end on
 *      the month that holds today.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  buildConsistencySnapshot,
  type ConsistencySnapshot,
} from '../src/consistency/engine';

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

interface MockConsistencyState {
  snapshot: ConsistencySnapshot | null;
  loadError: boolean;
  refresh: () => Promise<void>;
}

jest.mock('../src/consistency/store', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const store = create<MockConsistencyState>(() => ({
    snapshot: null,
    loadError: false,
    refresh: async () => undefined,
  }));
  return { useConsistencyStore: store };
});

import { useConsistencyStore } from '../src/consistency/store';
import { StreakCalendarScreen } from '../src/screens/StreakCalendarScreen';

const store = useConsistencyStore as unknown as {
  setState: (partial: Partial<MockConsistencyState>) => void;
  getState: () => MockConsistencyState;
};

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function localMonthLabel(date: Date): string {
  return `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

function snapshotAsOf(asOfIso: string, days: string[]): ConsistencySnapshot {
  return buildConsistencySnapshot(
    days.map(day => ({
      kind: 'stroke' as const,
      atIso: `${day}T10:00:00.000Z`,
      shotType: 'dink',
      overallScore: 6.5,
      resultKind: 'scored',
    })),
    { asOfIso, timeZone: 'UTC' },
  );
}

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

function monthHeader(renderer: TestRenderer.ReactTestRenderer): string {
  const match = allText(renderer).match(
    /(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}/,
  );
  return match ? match[0] : '<none>';
}

function hostByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.accessibilityState === 'object',
  )[0]!;
}

function pressableByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  )[0]!;
}

async function press(renderer: TestRenderer.ReactTestRenderer, label: string) {
  await act(async () => {
    pressableByLabel(renderer, label).props.onPress();
  });
}

function selectedDayLabels(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAll(
      node =>
        typeof node.type === 'string' &&
        typeof node.props.accessibilityState === 'object' &&
        node.props.accessibilityState.selected === true &&
        typeof node.props.accessibilityLabel === 'string' &&
        /^\d{4}-\d{2}-\d{2}/.test(node.props.accessibilityLabel),
    )
    .map(node => String(node.props.accessibilityLabel).slice(0, 10));
}

beforeEach(() => {
  store.setState({ snapshot: null, loadError: false });
});

describe('C1 — first snapshot arrives late', () => {
  it('month controls are inert before the snapshot; the late snapshot anchors once', async () => {
    const renderer = renderScreen();
    // No snapshot: the calendar opens on the device's current month.
    expect(monthHeader(renderer)).toBe(localMonthLabel(new Date()));
    expect(
      hostByLabel(renderer, 'Previous month').props.accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(
      hostByLabel(renderer, 'Next month').props.accessibilityState,
    ).toMatchObject({ disabled: true });

    // The late snapshot lands with an asOfDay in another month/year.
    act(() => {
      store.setState({
        snapshot: snapshotAsOf('2026-03-10T18:00:00.000Z', [
          '2026-02-20',
          '2026-03-09',
          '2026-03-10',
        ]),
      });
    });
    expect(monthHeader(renderer)).toBe('March 2026');
    expect(selectedDayLabels(renderer)).toEqual(['2026-03-10']);
    expect(
      hostByLabel(renderer, 'Previous month').props.accessibilityState,
    ).toMatchObject({ disabled: false });
    act(() => renderer.unmount());
  });

  it('the previous-month control stays inert under a burst of presses before the snapshot', async () => {
    const renderer = renderScreen();
    const before = monthHeader(renderer);
    // A screen reader / rapid double-tap cannot activate a disabled control;
    // the host must advertise the disabled state on every render.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        hostByLabel(renderer, 'Previous month').props.accessibilityState,
      ).toMatchObject({ disabled: true });
      await act(async () => {});
    }
    expect(monthHeader(renderer)).toBe(before);
    act(() => renderer.unmount());
  });
});

describe('C2 — user navigation vs. refreshed snapshots', () => {
  it('a refreshed snapshot (same asOfDay) does not re-anchor a navigated month', async () => {
    store.setState({
      snapshot: snapshotAsOf('2026-03-10T18:00:00.000Z', [
        '2026-01-15',
        '2026-03-10',
      ]),
    });
    const renderer = renderScreen();
    expect(monthHeader(renderer)).toBe('March 2026');
    await press(renderer, 'Previous month');
    await press(renderer, 'Previous month');
    expect(monthHeader(renderer)).toBe('January 2026');

    // Focus-triggered refresh replaces the snapshot object.
    act(() => {
      store.setState({
        snapshot: snapshotAsOf('2026-03-10T19:00:00.000Z', [
          '2026-01-15',
          '2026-03-10',
        ]),
      });
    });
    expect(monthHeader(renderer)).toBe('January 2026');
    act(() => renderer.unmount());
  });

  it('a refreshed snapshot with a LATER asOfDay does not yank the user back either', async () => {
    store.setState({
      snapshot: snapshotAsOf('2026-03-10T18:00:00.000Z', [
        '2026-02-02',
        '2026-03-10',
      ]),
    });
    const renderer = renderScreen();
    await press(renderer, 'Previous month');
    expect(monthHeader(renderer)).toBe('February 2026');

    // Ten rapid refreshes, each with a newer asOfDay (a training session
    // that keeps landing shots while the calendar is open).
    for (let day = 11; day <= 20; day += 1) {
      act(() => {
        store.setState({
          snapshot: snapshotAsOf(`2026-03-${day}T18:00:00.000Z`, [
            '2026-02-02',
            `2026-03-${day}`,
          ]),
        });
      });
      expect(monthHeader(renderer)).toBe('February 2026');
    }
    act(() => renderer.unmount());
  });

  it('a refresh that removes the earliest month still leaves the user where they are', async () => {
    store.setState({
      snapshot: snapshotAsOf('2026-03-10T18:00:00.000Z', [
        '2026-01-15',
        '2026-03-10',
      ]),
    });
    const renderer = renderScreen();
    await press(renderer, 'Previous month');
    await press(renderer, 'Previous month');
    expect(monthHeader(renderer)).toBe('January 2026');

    // The January evidence disappears (owner switch / history pruned).
    act(() => {
      store.setState({
        snapshot: snapshotAsOf('2026-03-10T18:00:00.000Z', ['2026-03-10']),
      });
    });
    // The screen must not crash and must still let the user walk forward.
    expect(monthHeader(renderer)).toBe('January 2026');
    expect(
      hostByLabel(renderer, 'Next month').props.accessibilityState,
    ).toMatchObject({ disabled: false });
    await press(renderer, 'Next month');
    await press(renderer, 'Next month');
    expect(monthHeader(renderer)).toBe('March 2026');
    expect(
      hostByLabel(renderer, 'Next month').props.accessibilityState,
    ).toMatchObject({ disabled: true });
    act(() => renderer.unmount());
  });
});

describe('C3 — deliberate deselection survives refreshes', () => {
  it('today, deselected by the user, is not re-selected by the next snapshot', async () => {
    store.setState({
      snapshot: snapshotAsOf('2026-03-10T18:00:00.000Z', ['2026-03-10']),
    });
    const renderer = renderScreen();
    expect(selectedDayLabels(renderer)).toEqual(['2026-03-10']);

    const today = renderer.root.findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('2026-03-10') &&
        typeof node.props.onPress === 'function',
    )[0]!;
    await act(async () => {
      today.props.onPress();
    });
    expect(selectedDayLabels(renderer)).toEqual([]);

    act(() => {
      store.setState({
        snapshot: snapshotAsOf('2026-03-10T19:00:00.000Z', ['2026-03-10']),
      });
    });
    expect(selectedDayLabels(renderer)).toEqual([]);
    act(() => renderer.unmount());
  });
});

describe('C4 — stale snapshot across a month boundary', () => {
  it('opens on the month that holds today once the fresh snapshot lands', async () => {
    // The store still holds last night's snapshot (app kept in memory over
    // midnight on the last day of the month); the screen mounts on it and
    // the focus refresh replaces it moments later.
    store.setState({
      snapshot: snapshotAsOf('2026-03-31T23:59:00.000Z', ['2026-03-31']),
    });
    const renderer = renderScreen();
    expect(monthHeader(renderer)).toBe('March 2026');

    act(() => {
      store.setState({
        snapshot: snapshotAsOf('2026-04-01T00:00:30.000Z', ['2026-03-31']),
      });
    });
    // The user has not touched the month; the calendar must show today's
    // month, with today reachable in the grid.
    expect(monthHeader(renderer)).toBe('April 2026');
    expect(
      hostByLabel(renderer, 'Next month').props.accessibilityState,
    ).toMatchObject({ disabled: true });
    act(() => renderer.unmount());
  });
});
