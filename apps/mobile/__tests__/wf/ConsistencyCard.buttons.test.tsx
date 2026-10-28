/**
 * Button ledger for `src/consistency/ConsistencyCard.tsx`.
 *
 * The card has exactly ONE interactive element — the whole card is a
 * `PressableScale` (testID `consistency-card`) whose `onPress` the parent
 * (ProgressScreen) wires to `navigation.navigate('StreakCalendar')`. Every
 * render state (empty, at-risk, secured, mid-run) must keep that press
 * wired, enabled, and accessible, and none may throw on a null snapshot.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { buildConsistencySnapshot } from '../../src/consistency/engine';
import type { RootStackParams } from '../../src/navigation/params';

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

import { ConsistencyCard } from '../../src/consistency/ConsistencyCard';

// ProgressScreen's wiring: `onPress={() => navigation.navigate('StreakCalendar')}`.
// Typing the route against RootStackParams makes tsc fail if it disappears.
const STREAK_ROUTE: keyof RootStackParams = 'StreakCalendar';

const trainedThreeDays = [
  {
    kind: 'stroke' as const,
    atIso: '2026-03-08T10:00:00.000Z',
    shotType: 'dink' as const,
    overallScore: 6.2,
    resultKind: 'scored' as const,
  },
  {
    kind: 'stroke' as const,
    atIso: '2026-03-09T10:00:00.000Z',
    shotType: 'forehand_drive' as const,
    overallScore: 7.4,
    resultKind: 'scored' as const,
  },
  {
    kind: 'stroke' as const,
    atIso: '2026-03-10T09:00:00.000Z',
    shotType: 'serve' as const,
    overallScore: 8.1,
    resultKind: 'scored' as const,
  },
];

const securedSnapshot = buildConsistencySnapshot(trainedThreeDays, {
  asOfIso: '2026-03-10T18:00:00.000Z',
  timeZone: 'UTC',
});

const atRiskSnapshot = buildConsistencySnapshot(trainedThreeDays, {
  asOfIso: '2026-03-11T18:00:00.000Z',
  timeZone: 'UTC',
});

function renderCard(
  snapshot: Parameters<typeof ConsistencyCard>[0]['snapshot'],
  onPress: () => void,
) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <ConsistencyCard snapshot={snapshot} onPress={onPress} />,
    );
  });
  return renderer;
}

/** Every press target in the tree: the react-native `Pressable` elements. */
function findPressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(node => {
    if (typeof node.props.onPress !== 'function') return false;
    if (typeof node.type === 'string') return false;
    const type = node.type as { displayName?: string; name?: string };
    return (type.displayName ?? type.name) === 'Pressable';
  });
}

function findCard(renderer: TestRenderer.ReactTestRenderer) {
  return findPressables(renderer).find(
    node => node.props.testID === 'consistency-card',
  )!;
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

/** The seven week dots, oldest first, as their state names. */
function weekStates(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(
      node =>
        typeof node.type === 'string' &&
        String(node.props.testID).startsWith('consistency-day-'),
    )
    .map(node => String(node.props.testID).replace('consistency-day-', ''));
}

describe('ConsistencyCard button ledger', () => {
  it('consistency-card -> onPress navigates to StreakCalendar (secured run)', () => {
    const navigate = jest.fn();
    const renderer = renderCard(securedSnapshot, () => navigate(STREAK_ROUTE));
    const card = findCard(renderer);

    expect(card.props.accessibilityRole).toBe('button');
    expect(securedSnapshot.currentStreak).toBe(3);
    expect(card.props.accessibilityLabel).toBe(
      'Streak: 3 days. Opens the streak calendar.',
    );
    expect(card.props.disabled).toBeUndefined();
    expect(card.props.accessibilityState).toMatchObject({
      disabled: undefined,
    });

    act(() => {
      card.props.onPress();
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('StreakCalendar');

    // The press is a synchronous navigation with no pending state, so the
    // card stays enabled and a second tap is delivered too (the navigator
    // dedupes an already-focused route).
    act(() => {
      card.props.onPress();
    });
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(findCard(renderer).props.disabled).toBeUndefined();

    const copy = allText(renderer);
    expect(copy).toContain('3-day streak');
    expect(copy).toContain('Day 3 secured · 3 of the last 7 days');
    // Momentum, shields and milestones live on the calendar, not the card.
    expect(copy).not.toContain('MOMENTUM');
    expect(copy).not.toContain('XP');
    expect(copy).not.toContain('NEXT:');
    // Mar 4–10, oldest first: the run is Mar 8, 9 and 10 (today).
    expect(weekStates(renderer)).toEqual([
      'rest',
      'rest',
      'rest',
      'rest',
      'trained',
      'trained',
      'trained',
    ]);
    expect(copy).toContain('W T F S S M T');
    act(() => renderer.unmount());
  });

  it('consistency-card -> onPress stays wired when the streak is at risk', () => {
    const onPress = jest.fn();
    const renderer = renderCard(atRiskSnapshot, onPress);
    expect(atRiskSnapshot.atRisk).toBe(true);

    const copy = allText(renderer);
    expect(copy).toContain(
      'No training yet today — one analysis keeps it alive.',
    );
    // Today (Mar 11) is still open: the last dot is a rest day.
    expect(weekStates(renderer)).toEqual([
      'rest',
      'rest',
      'rest',
      'trained',
      'trained',
      'trained',
      'rest',
    ]);

    act(() => {
      findCard(renderer).props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('consistency-card -> onPress works with a null snapshot (empty state)', () => {
    const onPress = jest.fn();
    const renderer = renderCard(null, onPress);
    const card = findCard(renderer);

    expect(card.props.accessibilityRole).toBe('button');
    expect(card.props.accessibilityLabel).toBe(
      'Streak: 0 days. Opens the streak calendar.',
    );

    const copy = allText(renderer);
    expect(copy).toContain('No streak yet');
    expect(copy).toContain('Your first analysis lights the flame.');
    // Before a snapshot exists the week still renders: seven open days.
    expect(weekStates(renderer)).toEqual(Array(7).fill('rest'));

    act(() => {
      card.props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('consistency-card -> onPress works for a fresh account with zero activities', () => {
    const emptySnapshot = buildConsistencySnapshot([], {
      asOfIso: '2026-03-10T18:00:00.000Z',
      timeZone: 'UTC',
    });
    expect(emptySnapshot.totalActivities).toBe(0);

    const onPress = jest.fn();
    const renderer = renderCard(emptySnapshot, onPress);
    const copy = allText(renderer);
    expect(copy).toContain('No streak yet');
    expect(copy).toContain('Your first analysis lights the flame.');
    expect(weekStates(renderer)).toEqual(Array(7).fill('rest'));

    act(() => {
      findCard(renderer).props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('marks a shield-bridged day with its own dot', () => {
    const shielded = {
      ...securedSnapshot,
      days: {
        ...securedSnapshot.days,
        '2026-03-07': {
          ...securedSnapshot.days['2026-03-08']!,
          day: '2026-03-07',
          shielded: true,
        },
      },
    };
    const renderer = renderCard(shielded, () => undefined);
    expect(weekStates(renderer)).toEqual([
      'rest',
      'rest',
      'rest',
      'shielded',
      'trained',
      'trained',
      'trained',
    ]);
    act(() => renderer.unmount());
  });

  it('has exactly one pressable — the card itself', () => {
    const renderer = renderCard(securedSnapshot, () => undefined);
    const pressables = findPressables(renderer);
    expect(pressables).toHaveLength(1);
    expect(pressables[0]!.props.testID).toBe('consistency-card');
    act(() => renderer.unmount());
  });
});
