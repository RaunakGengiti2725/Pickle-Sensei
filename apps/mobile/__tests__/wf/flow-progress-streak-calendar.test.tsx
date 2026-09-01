/**
 * Streak calendar flow, driven as a player would: arrive from Progress or
 * Home, read the streak hero, walk months back to the earliest history and
 * forward to today (never beyond), open and close day details, inspect a
 * shielded day, browse achievements, and leave through the header back
 * control. Fixtures run through the real consistency engine so the screen
 * can never disagree with the streak rules (7-day shield, auto-spend).
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  buildConsistencySnapshot,
  type ConsistencySnapshot,
  type TrainingActivityInput,
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

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
let mockFocusRuns = 0;
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => {
      mockFocusRuns += 1;
      return callback();
    }, [callback]);
  },
}));

const mockStore = {
  snapshot: null as ConsistencySnapshot | null,
  refresh: jest.fn(async () => undefined),
};
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (selector: (state: typeof mockStore) => unknown) =>
    selector(mockStore),
}));

import { StreakCalendarScreen } from '../../src/screens/StreakCalendarScreen';

const AS_OF = '2026-03-09T18:00:00.000Z';

function stroke(day: string, score: number, shotType = 'dink') {
  return {
    kind: 'stroke',
    atIso: `${day}T10:00:00.000Z`,
    shotType,
    overallScore: score,
    resultKind: 'scored',
  } satisfies TrainingActivityInput;
}

/** One February day of history, then Mar 1–7 trained (earns a shield),
 * Mar 8 missed (shield auto-spent), Mar 9 = today trained. */
const shieldedHistory: TrainingActivityInput[] = [
  stroke('2026-02-20', 5.5),
  ...['01', '02', '03', '04', '05', '06', '07'].map(d =>
    stroke(`2026-03-${d}`, 6 + Number(d) / 10),
  ),
  { kind: 'drill', atIso: '2026-03-07T12:00:00.000Z', label: 'Dink ladder' },
  stroke('2026-03-09', 7.9, 'serve'),
];

function snapshotFor(activities: TrainingActivityInput[]) {
  return buildConsistencySnapshot(activities, {
    asOfIso: AS_OF,
    timeZone: 'UTC',
  });
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

function pressable(
  renderer: TestRenderer.ReactTestRenderer,
  match: (label: string) => boolean,
) {
  const [node] = renderer.root.findAll(
    n =>
      typeof n.props.accessibilityLabel === 'string' &&
      match(n.props.accessibilityLabel) &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error('No pressable matched');
  return node;
}

function host(
  renderer: TestRenderer.ReactTestRenderer,
  match: (label: string) => boolean,
) {
  const [node] = renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      typeof n.props.accessibilityLabel === 'string' &&
      match(n.props.accessibilityLabel),
  );
  if (!node) throw new Error('No host matched');
  return node;
}

async function pressLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  const node = pressable(renderer, l => l === label);
  await act(async () => {
    node.props.onPress();
  });
}

function dayDetail(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === 'streak-day-detail',
  );
}

describe('flow: streak calendar', () => {
  beforeEach(() => {
    mockGoBack.mockClear();
    mockNavigate.mockClear();
    mockStore.refresh.mockClear();
    mockFocusRuns = 0;
    mockStore.snapshot = snapshotFor(shieldedHistory);
  });

  it('refreshes on focus, shows the shield-aware hero, and leaves through Back', async () => {
    const renderer = renderScreen();
    expect(mockStore.refresh).toHaveBeenCalledTimes(1);
    expect(mockFocusRuns).toBe(1);

    const copy = allText(renderer);
    // Streak survived the Mar 8 miss through the shield earned on Mar 7;
    // the shielded day bridges the run without growing it (8, not 9).
    expect(mockStore.snapshot!.currentStreak).toBe(8);
    expect(mockStore.snapshot!.shieldsAvailable).toBe(0);
    expect(mockStore.snapshot!.days['2026-03-08']?.shielded).toBe(true);
    expect(copy).toContain('8 DAY STREAK');
    expect(copy).toContain('Day 8 secured');
    expect(copy).toContain('March 2026');
    expect(copy).toContain('LONGEST');
    expect(copy).toContain('SHIELDS');

    const back = host(renderer, l => l === 'Back');
    expect(back.props.accessibilityRole).toBe('button');
    await pressLabel(renderer, 'Back');
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('walks months back to the earliest history and forward to today, never beyond', async () => {
    const renderer = renderScreen();
    const nextHost = () => host(renderer, l => l === 'Next month');
    const prevHost = () => host(renderer, l => l === 'Previous month');

    expect(nextHost().props.accessibilityRole).toBe('button');
    expect(nextHost().props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(prevHost().props.accessibilityState).toMatchObject({
      disabled: false,
    });

    await pressLabel(renderer, 'Previous month');
    expect(allText(renderer)).toContain('February 2026');
    // February holds the earliest training day → no further back.
    expect(prevHost().props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(nextHost().props.accessibilityState).toMatchObject({
      disabled: false,
    });

    await pressLabel(renderer, 'Next month');
    expect(allText(renderer)).toContain('March 2026');
    expect(nextHost().props.accessibilityState).toMatchObject({
      disabled: true,
    });
    act(() => renderer.unmount());
  });

  it('opens today automatically, toggles a day closed and re-opens another', async () => {
    const renderer = renderScreen();
    // Today was trained → its detail opens once on arrival.
    expect(dayDetail(renderer)).toHaveLength(1);
    let copy = allText(renderer);
    expect(copy).toContain('serve');
    expect(copy).toContain('1 ACTIVITY');
    expect(copy).toContain('AVG 7.9');

    const todayLabel = (l: string) => l.startsWith('2026-03-09, trained');
    expect(host(renderer, todayLabel).props.accessibilityRole).toBe('button');

    // Second tap on the open day closes it — and it stays closed.
    await act(async () => {
      pressable(renderer, todayLabel).props.onPress();
    });
    expect(dayDetail(renderer)).toHaveLength(0);

    // Another trained day opens with exactly its own activities.
    await act(async () => {
      pressable(renderer, l =>
        l.startsWith('2026-03-07, trained'),
      ).props.onPress();
    });
    expect(dayDetail(renderer)).toHaveLength(1);
    copy = allText(renderer);
    expect(copy).toContain('Dink ladder');
    expect(copy).toContain('2 ACTIVITIES');
    expect(copy).toContain('DRILL');
    expect(copy).not.toContain('serve');

    // Double tap: second press of a different day just moves the selection.
    await act(async () => {
      const d5 = pressable(renderer, l => l.startsWith('2026-03-05, trained'));
      d5.props.onPress();
      d5.props.onPress();
    });
    expect(dayDetail(renderer)).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('explains a shielded day honestly and keeps rest and future days inert', async () => {
    const renderer = renderScreen();
    const shieldedLabel = (l: string) => l === '2026-03-08, shield protected';
    expect(
      host(renderer, shieldedLabel).props.accessibilityState,
    ).toMatchObject({ disabled: false });
    await act(async () => {
      pressable(renderer, shieldedLabel).props.onPress();
    });
    expect(allText(renderer)).toContain(
      'A Streak Shield protected this day. No training logged — the run survived.',
    );

    // Future days are neither "not trained" nor pressable.
    const future = host(renderer, l => l === '2026-03-10');
    expect(future.props.accessibilityState).toMatchObject({ disabled: true });
    expect(
      renderer.root.findAll(
        n => n.props.accessibilityLabel === '2026-03-10, not trained',
      ),
    ).toHaveLength(0);

    // A past rest day announces itself and cannot be opened.
    await pressLabel(renderer, 'Previous month');
    const rest = host(renderer, l => l === '2026-02-21, not trained');
    expect(rest.props.accessibilityState).toMatchObject({ disabled: true });
    // The open shielded-day detail survives the month change.
    expect(dayDetail(renderer)).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('lets a player browse achievements: locked copy is honest and details toggle', async () => {
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy).toContain('Achievements');
    expect(copy).toContain('Next reward: Fortnight Form — 6 days away');

    const weekOne = host(renderer, l => l.startsWith('Week One.'));
    expect(weekOne.props.accessibilityLabel).toMatch(/^Week One\. Earned/);
    expect(weekOne.props.accessibilityRole).toBe('button');
    const fortnight = host(renderer, l => l.startsWith('Fortnight Form.'));
    expect(fortnight.props.accessibilityLabel).toBe(
      'Fortnight Form. Locked. 6 days away',
    );

    await act(async () => {
      pressable(renderer, l => l.startsWith('Fortnight Form.')).props.onPress();
    });
    expect(allText(renderer)).toContain('Two weeks without letting go.');
    await act(async () => {
      pressable(renderer, l => l.startsWith('Fortnight Form.')).props.onPress();
    });
    expect(allText(renderer)).not.toContain('Two weeks without letting go.');
    act(() => renderer.unmount());
  });

  it('never invents history for a fresh account and still offers a way back', async () => {
    mockStore.snapshot = snapshotFor([]);
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy).toContain('0 DAY STREAK');
    expect(copy).toContain('Your first analysis lights the flame.');
    expect(copy).toContain('MOMENTUM LEVEL 1');
    expect(copy).toContain('Next reward: First Spark — 1 day away');
    expect(dayDetail(renderer)).toHaveLength(0);
    // No history: both month arrows rest disabled on the current month.
    expect(
      host(renderer, l => l === 'Previous month').props.accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(
      host(renderer, l => l === 'Next month').props.accessibilityState,
    ).toMatchObject({ disabled: true });
    // Every day this month is a rest day and inert.
    expect(
      renderer.root.findAll(
        n =>
          typeof n.props.accessibilityLabel === 'string' &&
          n.props.accessibilityLabel.startsWith('2026-03') &&
          typeof n.props.onPress === 'function' &&
          n.props.disabled !== true,
      ),
    ).toHaveLength(0);
    await pressLabel(renderer, 'Back');
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('never counts app opens: the fixture streak equals its trained days', () => {
    const snapshot = snapshotFor(shieldedHistory);
    // 8 trained days on the run (Mar 1–7, 9; Mar 8 bridged by a shield),
    // 9 trained days total incl. Feb 20 — never calendar days since install.
    expect(snapshot.totalTrainedDays).toBe(9);
    expect(snapshot.currentStreak).toBe(8);
    expect(snapshot.shieldsEarnedTotal).toBe(1);
    expect(snapshot.shieldedDayCount).toBe(1);
  });
});
