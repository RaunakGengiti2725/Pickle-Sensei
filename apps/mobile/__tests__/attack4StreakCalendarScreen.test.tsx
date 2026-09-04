/**
 * Adversarial pass 3 (tester #4) — StreakCalendarScreen.
 *
 * Attacks: pressing future / untrained cells, the December → January year
 * boundary (grid shape + heat tints), forward navigation blocked at the
 * current month, rapid repeated presses, and a hostile snapshot (day keys
 * outside the visible range, shielded days). Assertions read the HOST
 * `Pressable` that React Native actually gates touches on, not only the
 * PressableScale wrapper.
 */

import React from 'react';
import { StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  buildConsistencySnapshot,
  dayHeatLevel,
  type ConsistencySnapshot,
  type TrainingActivityInput,
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

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn() }),
  useFocusEffect: () => {},
}));

const mockState: { snapshot: ConsistencySnapshot | null; loadError: boolean } =
  { snapshot: null, loadError: false };
const mockRefresh = jest.fn(async () => undefined);
jest.mock('../src/consistency/store', () => ({
  useConsistencyStore: (selector: (state: unknown) => unknown) =>
    selector({
      snapshot: mockState.snapshot,
      loadError: mockState.loadError,
      refresh: mockRefresh,
    }),
}));

import { StreakCalendarScreen } from '../src/screens/StreakCalendarScreen';
import { PressableScale } from '../src/design/components';

const HEAT_TINTS = [
  'transparent',
  'rgba(255,155,66,0.14)',
  'rgba(255,155,66,0.24)',
  'rgba(255,131,41,0.34)',
] as const;

function stroke(atIso: string): TrainingActivityInput {
  return {
    kind: 'stroke',
    atIso,
    shotType: 'dink',
    overallScore: 6,
    resultKind: 'scored',
  };
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

/** React Native `Pressable` elements (the layer whose `disabled` gates
 * touches). Identified by the onPressIn/onPressOut pair PressableScale wires
 * only onto the real Pressable. */
function pressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.props.onPressIn === 'function' &&
      typeof node.props.accessibilityLabel === 'string' &&
      typeof node.type !== 'string',
  );
}

/** The RN Pressable rendered for a day cell (label starts with the key). */
function hostCell(renderer: TestRenderer.ReactTestRenderer, day: string) {
  const matches = pressables(renderer).filter(node =>
    (node.props.accessibilityLabel as string).startsWith(day),
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

/** The native host View beneath a day cell (what the a11y tree exposes). */
function hostView(renderer: TestRenderer.ReactTestRenderer, day: string) {
  const matches = renderer.root.findAll(
    node =>
      String(node.type) === 'View' &&
      typeof node.props.accessibilityLabel === 'string' &&
      (node.props.accessibilityLabel as string).startsWith(day),
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

/** Wrapper PressableScale node for a day (holds the onPress the screen set). */
function wrapperCell(renderer: TestRenderer.ReactTestRenderer, day: string) {
  return renderer.root
    .findAllByType(PressableScale)
    .filter(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith(day),
    )[0]!;
}

/** Month navigation arrow wrapper ('Previous month' | 'Next month'). */
function arrow(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(PressableScale)
    .filter(node => node.props.accessibilityLabel === label);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function selectedDays(renderer: TestRenderer.ReactTestRenderer): string[] {
  return pressables(renderer)
    .filter(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        /^\d{4}-\d{2}-\d{2}/.test(node.props.accessibilityLabel) &&
        node.props.accessibilityState?.selected === true,
    )
    .map(node => (node.props.accessibilityLabel as string).slice(0, 10));
}

function dayDetail(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      node.props.testID === 'streak-day-detail' && String(node.type) === 'View',
  );
}

function dayKeysInGrid(renderer: TestRenderer.ReactTestRenderer): string[] {
  return pressables(renderer)
    .map(node => node.props.accessibilityLabel)
    .filter(
      (label): label is string =>
        typeof label === 'string' && /^\d{4}-\d{2}-\d{2}/.test(label),
    )
    .map(label => label.slice(0, 10));
}

function heatOf(renderer: TestRenderer.ReactTestRenderer, day: string) {
  // The wrapper's `style` carries the heat tint; find the Animated host view
  // beneath the host Pressable and flatten its style.
  const wrapper = wrapperCell(renderer, day);
  const flat = StyleSheet.flatten(wrapper.props.style) as {
    backgroundColor?: string;
  };
  const index = HEAT_TINTS.indexOf(
    (flat.backgroundColor ?? 'transparent') as (typeof HEAT_TINTS)[number],
  );
  // A shielded cell carries its own (non-heat) background → heat 0.
  return index === -1 ? 0 : index;
}

function backgroundOf(renderer: TestRenderer.ReactTestRenderer, day: string) {
  const flat = StyleSheet.flatten(wrapperCell(renderer, day).props.style) as {
    backgroundColor?: string;
  };
  return flat.backgroundColor;
}

afterEach(() => {
  mockState.snapshot = null;
  mockState.loadError = false;
});

describe('attack4: future and untrained cells', () => {
  const asOfIso = '2026-03-10T18:00:00.000Z';
  beforeEach(() => {
    mockState.snapshot = buildConsistencySnapshot(
      [
        stroke('2026-03-08T10:00:00.000Z'),
        stroke('2026-03-09T10:00:00.000Z'),
        stroke('2026-03-10T09:00:00.000Z'),
      ],
      { asOfIso, timeZone: 'UTC' },
    );
  });

  it('a future day cell is disabled at the host Pressable and cannot select', async () => {
    const renderer = renderScreen();
    // Today (trained) is auto-selected.
    expect(selectedDays(renderer)).toEqual(['2026-03-10']);

    const future = hostCell(renderer, '2026-03-25');
    expect(future.props.disabled).toBe(true);
    expect(future.props.accessibilityState).toMatchObject({
      disabled: true,
      selected: false,
    });
    // …and the native host view VoiceOver reads agrees.
    expect(
      hostView(renderer, '2026-03-25').props.accessibilityState,
    ).toMatchObject({ disabled: true, selected: false });
    // Future cells carry no ", not trained" suffix and no onPress at the
    // host level that could change selection.
    expect(future.props.accessibilityLabel).toBe('2026-03-25');

    // The only guard is `disabled` on the Pressable: React Native's
    // Pressability never fires onPress for a disabled Pressable, so a tap on
    // the cell cannot reach the handler. Calling the handler directly
    // (bypassing RN entirely) DOES toggle selection — pinned here so a future
    // refactor that drops `disabled` fails this test loudly.
    const wrapper = wrapperCell(renderer, '2026-03-25');
    expect(wrapper.props.disabled).toBe(true);
    await act(async () => {
      wrapper.props.onPress();
    });
    expect(selectedDays(renderer)).toEqual(['2026-03-25']);
    await act(async () => {
      wrapper.props.onPress();
    });
    expect(selectedDays(renderer)).toEqual([]);
    act(() => renderer.unmount());
  });

  it('every future and untrained cell in the month is disabled; every trained cell is enabled', () => {
    const renderer = renderScreen();
    const snapshot = mockState.snapshot!;
    for (const day of dayKeysInGrid(renderer)) {
      const host = hostCell(renderer, day);
      const trained = Boolean(snapshot.days[day]);
      expect(host.props.disabled).toBe(!trained);
      expect(host.props.accessibilityState.disabled).toBe(!trained);
      if (day > snapshot.asOfDay) {
        expect(host.props.accessibilityLabel).toBe(day);
      } else if (!trained) {
        expect(host.props.accessibilityLabel).toBe(`${day}, not trained`);
      }
    }
    act(() => renderer.unmount());
  });

  it('rapid repeated presses on a trained day toggle deterministically', async () => {
    const renderer = renderScreen();
    const day = wrapperCell(renderer, '2026-03-09');
    for (let i = 0; i < 7; i += 1) {
      await act(async () => {
        day.props.onPress();
      });
    }
    // 7 presses: select(1) → deselect(2) → … → selected after odd count.
    expect(selectedDays(renderer)).toEqual(['2026-03-09']);
    expect(dayDetail(renderer)).toHaveLength(1);
    await act(async () => {
      day.props.onPress();
    });
    expect(selectedDays(renderer)).toEqual([]);
    expect(dayDetail(renderer)).toHaveLength(0);
    act(() => renderer.unmount());
  });
});

describe('attack4: December → January year boundary', () => {
  const dayCounts: Record<string, number> = {
    '2026-12-20': 1,
    '2026-12-21': 2,
    '2026-12-22': 3,
    '2026-12-23': 4,
    '2026-12-24': 1,
    '2026-12-25': 1,
    '2026-12-26': 1,
    // Dec 27 missed — shield (earned on day 7 = Dec 26) covers it.
    '2026-12-28': 1,
    '2026-12-29': 1,
    '2026-12-30': 9,
    '2026-12-31': 1,
    '2027-01-01': 2,
    '2027-01-02': 1,
    // Jan 3 missed — the one banked shield went to Dec 27 → run resets.
    '2027-01-04': 4,
    '2027-01-05': 1,
  };
  const asOfIso = '2027-01-05T20:00:00.000Z';

  function buildSnapshot(): ConsistencySnapshot {
    const activities: TrainingActivityInput[] = [];
    for (const [day, count] of Object.entries(dayCounts)) {
      for (let i = 0; i < count; i += 1) {
        activities.push(
          stroke(`${day}T${String(8 + i).padStart(2, '0')}:00:00.000Z`),
        );
      }
    }
    return buildConsistencySnapshot(activities, {
      asOfIso,
      timeZone: 'UTC',
    });
  }

  beforeEach(() => {
    mockState.snapshot = buildSnapshot();
  });

  it('opens on January 2027, walks back to December 2026 and forward again with correct grids', async () => {
    const renderer = renderScreen();
    const snapshot = mockState.snapshot!;
    expect(allText(renderer)).toContain('January 2027');

    // January 2027 grid: Jan 1 is a Friday → Monday-first lead of 4 blanks,
    // 31 days → 5 rows.
    const janKeys = dayKeysInGrid(renderer);
    expect(janKeys).toHaveLength(31);
    expect(janKeys[0]).toBe('2027-01-01');
    expect(janKeys[30]).toBe('2027-01-31');
    expect(new Set(janKeys).size).toBe(31);

    const next = arrow(renderer, 'Next month');
    const previous = arrow(renderer, 'Previous month');
    expect(next.props.disabled).toBe(true);
    expect(previous.props.disabled).toBe(false);

    await act(async () => {
      previous.props.onPress();
    });
    expect(allText(renderer)).toContain('December 2026');
    const decKeys = dayKeysInGrid(renderer);
    expect(decKeys).toHaveLength(31);
    expect(decKeys[0]).toBe('2026-12-01');
    expect(decKeys[30]).toBe('2026-12-31');
    // No January cell leaked into the December grid and vice versa.
    expect(decKeys.every(k => k.startsWith('2026-12-'))).toBe(true);

    // Heat tints in December follow dayHeatLevel exactly.
    for (const day of decKeys) {
      const expected = dayHeatLevel(snapshot.days[day]);
      expect({ day, heat: heatOf(renderer, day) }).toEqual({
        day,
        heat: expected,
      });
    }
    expect(heatOf(renderer, '2026-12-20')).toBe(1);
    expect(heatOf(renderer, '2026-12-22')).toBe(2);
    expect(heatOf(renderer, '2026-12-23')).toBe(3);
    expect(heatOf(renderer, '2026-12-30')).toBe(3);
    expect(heatOf(renderer, '2026-12-19')).toBe(0);
    // Dec 27 is shielded: no tint, but the cell is enabled (it has a log).
    expect(snapshot.days['2026-12-27']?.shielded).toBe(true);
    expect(heatOf(renderer, '2026-12-27')).toBe(0);
    expect(HEAT_TINTS as readonly string[]).not.toContain(
      backgroundOf(renderer, '2026-12-27'),
    );
    expect(hostCell(renderer, '2026-12-27').props.disabled).toBe(false);
    expect(hostCell(renderer, '2026-12-27').props.accessibilityLabel).toBe(
      '2026-12-27, shield protected',
    );
    // December is the earliest month → previous disabled now.
    expect(arrow(renderer, 'Previous month').props.disabled).toBe(true);

    // Forward across the year boundary.
    const nextAgain = arrow(renderer, 'Next month');
    expect(nextAgain.props.disabled).toBe(false);
    await act(async () => {
      nextAgain.props.onPress();
    });
    expect(allText(renderer)).toContain('January 2027');
    expect(allText(renderer)).not.toContain('December 2026');
    const janAgain = dayKeysInGrid(renderer);
    expect(janAgain).toEqual(janKeys);
    // Today (Jan 5) was auto-selected: the selection background replaces the
    // heat tint on purpose. Every other cell must show its heat exactly.
    expect(selectedDays(renderer)).toEqual(['2027-01-05']);
    for (const day of janAgain.filter(k => k !== '2027-01-05')) {
      expect({ day, heat: heatOf(renderer, day) }).toEqual({
        day,
        heat: dayHeatLevel(snapshot.days[day]),
      });
    }
    expect(heatOf(renderer, '2027-01-01')).toBe(2);
    expect(heatOf(renderer, '2027-01-04')).toBe(3);
    expect(HEAT_TINTS as readonly string[]).not.toContain(
      backgroundOf(renderer, '2027-01-05'),
    );
    // Deselect today → its heat tint (1 activity) comes back.
    await act(async () => {
      wrapperCell(renderer, '2027-01-05').props.onPress();
    });
    expect(selectedDays(renderer)).toEqual([]);
    expect(heatOf(renderer, '2027-01-05')).toBe(1);
    // Jan 6 onward is the future: disabled, plain label, no tint.
    for (const day of janAgain.filter(k => k > '2027-01-05')) {
      const host = hostCell(renderer, day);
      expect(host.props.disabled).toBe(true);
      expect(host.props.accessibilityLabel).toBe(day);
      expect(heatOf(renderer, day)).toBe(0);
    }
    // Streak math at the boundary: Jan 3 miss with 0 shields left → reset.
    expect(snapshot.days['2026-12-27']?.shielded).toBe(true);
    expect(snapshot.days['2027-01-03']).toBeUndefined();
    expect(snapshot.currentStreak).toBe(2);
    // 7 trained + shielded Dec 27 (keeps the run, adds no day) + 6 trained.
    expect(snapshot.longestStreak).toBe(13);
    act(() => renderer.unmount());
  });

  it('a December asOfDay cannot navigate forward into a future January', async () => {
    mockState.snapshot = buildConsistencySnapshot(
      [stroke('2026-12-30T10:00:00.000Z'), stroke('2026-12-31T10:00:00.000Z')],
      { asOfIso: '2026-12-31T23:59:59.000Z', timeZone: 'UTC' },
    );
    const renderer = renderScreen();
    expect(allText(renderer)).toContain('December 2026');
    const nextHost = pressables(renderer).filter(
      node => node.props.accessibilityLabel === 'Next month',
    )[0]!;
    expect(nextHost.props.disabled).toBe(true);
    expect(nextHost.props.accessibilityState).toMatchObject({ disabled: true });
    expect(allText(renderer)).not.toContain('January 2027');
    // The forward gate is `disabled` alone (asserted above); the handler is
    // unguarded, so a direct call renders the future month. Pinned so the
    // gate cannot silently disappear.
    const wrapper = arrow(renderer, 'Next month');
    expect(wrapper.props.disabled).toBe(true);
    await act(async () => {
      wrapper.props.onPress();
    });
    expect(allText(renderer)).toContain('January 2027');
    // Every cell of that future month is disabled and unlabeled as trained.
    for (const day of dayKeysInGrid(renderer)) {
      expect(hostCell(renderer, day).props.disabled).toBe(true);
      expect(hostCell(renderer, day).props.accessibilityLabel).toBe(day);
    }
    act(() => renderer.unmount());
  });
});

describe('attack4: hostile snapshots', () => {
  it('renders when the snapshot is null and loadError is set', () => {
    mockState.snapshot = null;
    mockState.loadError = true;
    const renderer = renderScreen();
    expect(allText(renderer).length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('renders an empty snapshot and marks every cell untrained/future', () => {
    mockState.snapshot = buildConsistencySnapshot([], {
      asOfIso: '2026-02-14T12:00:00.000Z',
      timeZone: 'UTC',
    });
    const renderer = renderScreen();
    expect(allText(renderer)).toContain('February 2026');
    const keys = dayKeysInGrid(renderer);
    expect(keys).toHaveLength(28);
    for (const day of keys) {
      expect(hostCell(renderer, day).props.disabled).toBe(true);
    }
    expect(selectedDays(renderer)).toEqual([]);
    expect(allText(renderer)).toContain(
      'Your first analysis lights the flame.',
    );
    act(() => renderer.unmount());
  });

  it('a 400-day history renders and the month navigation stays bounded', async () => {
    const activities: TrainingActivityInput[] = [];
    for (let i = 0; i < 400; i += 1) {
      const date = new Date(Date.UTC(2026, 2, 10) - i * 86_400_000);
      activities.push(
        stroke(`${date.toISOString().slice(0, 10)}T10:00:00.000Z`),
      );
    }
    mockState.snapshot = buildConsistencySnapshot(activities, {
      asOfIso: '2026-03-10T18:00:00.000Z',
      timeZone: 'UTC',
    });
    expect(mockState.snapshot.currentStreak).toBe(400);
    const renderer = renderScreen();
    expect(allText(renderer)).toContain('400');
    let presses = 0;
    // Walk back until the previous arrow disables; must terminate at the
    // earliest trained month (Feb 2025), never earlier.
    for (;;) {
      const previous = arrow(renderer, 'Previous month');
      if (previous.props.disabled) break;
      await act(async () => {
        previous.props.onPress();
      });
      presses += 1;
      expect(presses).toBeLessThan(20);
    }
    expect(presses).toBe(13); // Mar 2026 → Feb 2025
    expect(allText(renderer)).toContain('February 2025');
    act(() => renderer.unmount());
  });
});
