import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { buildConsistencySnapshot } from '../src/consistency/engine';

// The mobile tsconfig has no Node types (matches __tests__/liveCourt.test.ts).
declare const process: { env: Record<string, string | undefined> };

/**
 * Device-zone attack case for the streak calendar's day labels.
 *
 * The consistency engine keys days by YYYY-MM-DD in the device zone and the
 * calendar grid places them by UTC arithmetic — both zone-safe. The
 * human-readable labels (the selected-day heading and the achievements
 * "earned on" meta) must name the SAME calendar day in every device zone,
 * including zones at or beyond UTC+12 (Auckland in southern summer, Tonga,
 * Kiritimati at UTC+14), where a naive "noon UTC" round-trip through the
 * device zone lands on the next calendar day.
 *
 * This file is run by __tests__/attack4StreakCalendarDeviceZone.test.ts in a
 * child jest with TZ pinned to such a zone, and can be run directly with any
 * TZ, e.g. `TZ=Pacific/Kiritimati npx jest --ci attack/…tzcase.tsx`.
 */

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

// Day keys are fixed by building the snapshot in UTC, so the SAME keys are
// on screen no matter which device zone this process runs in. Only the
// human-readable labels derived from those keys are under test.
const TRAINED_DAYS = ['2026-03-08', '2026-03-09', '2026-03-10'] as const;
const mockSnapshot = buildConsistencySnapshot(
  [
    {
      kind: 'stroke',
      atIso: `${TRAINED_DAYS[0]}T10:00:00.000Z`,
      shotType: 'dink',
      overallScore: 6.2,
      resultKind: 'scored',
    },
    {
      kind: 'stroke',
      atIso: `${TRAINED_DAYS[1]}T10:00:00.000Z`,
      shotType: 'forehand_drive',
      overallScore: 7.4,
      resultKind: 'scored',
    },
    {
      kind: 'stroke',
      atIso: `${TRAINED_DAYS[2]}T09:00:00.000Z`,
      shotType: 'serve',
      overallScore: 8.1,
      resultKind: 'scored',
    },
  ],
  { asOfIso: `${TRAINED_DAYS[2]}T18:00:00.000Z`, timeZone: 'UTC' },
);
const mockRefresh = jest.fn(async () => undefined);
jest.mock('../src/consistency/store', () => ({
  useConsistencyStore: (selector: (state: unknown) => unknown) =>
    selector({ snapshot: mockSnapshot, refresh: mockRefresh }),
}));

import { StreakCalendarScreen } from '../src/screens/StreakCalendarScreen';
import { AchievementsShowcase } from '../src/consistency/AchievementsShowcase';

/** The label a correct formatter produces for a YYYY-MM-DD key: the key's
 * own calendar day, in the device locale, with no zone round-trip. */
function expectedLabel(
  day: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  return new Intl.DateTimeFormat(undefined, {
    ...options,
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, dayOfMonth)));
}

function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function textNodes(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map(node =>
    React.Children.toArray(node.props.children)
      .filter((child): child is string | number =>
        ['string', 'number'].includes(typeof child),
      )
      .join(''),
  );
}

/** The first Text of the selected-day card is its date heading. */
function dayDetailHeading(renderer: TestRenderer.ReactTestRenderer): string {
  const detail = renderer.root.findAll(
    node => node.props.testID === 'streak-day-detail',
  )[0];
  if (!detail) throw new Error('day detail card not rendered');
  const heading = detail.findAllByType(Text)[0];
  if (!heading) throw new Error('day detail card has no heading');
  return React.Children.toArray(heading.props.children)
    .filter((child): child is string => typeof child === 'string')
    .join('');
}

const HEADING_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
};
const EARNED_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
};

describe(`StreakCalendar day labels in device zone ${
  Intl.DateTimeFormat().resolvedOptions().timeZone
}`, () => {
  it('runs in the zone the harness asked for', () => {
    const requested = process.env.TZ;
    if (requested) {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(requested);
    }
  });

  it('the auto-opened "today" heading names the snapshot asOfDay', () => {
    const renderer = render(<StreakCalendarScreen />);
    expect(mockSnapshot.trainedToday).toBe(true);
    const heading = dayDetailHeading(renderer);
    expect(heading).toBe(expectedLabel(mockSnapshot.asOfDay, HEADING_OPTIONS));
    expect(heading).not.toBe(
      expectedLabel(nextDay(mockSnapshot.asOfDay), HEADING_OPTIONS),
    );
    act(() => renderer.unmount());
  });

  it('the selected-day heading names the same calendar day as the tapped cell', async () => {
    const renderer = render(<StreakCalendarScreen />);
    const tapped = TRAINED_DAYS[1];
    const dayNode = renderer.root.findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith(`${tapped}, trained`) &&
        typeof node.props.onPress === 'function',
    )[0]!;
    await act(async () => {
      dayNode.props.onPress();
    });
    const heading = dayDetailHeading(renderer);
    expect(heading).toBe(expectedLabel(tapped, HEADING_OPTIONS));
    expect(heading).not.toBe(expectedLabel(nextDay(tapped), HEADING_OPTIONS));
    act(() => renderer.unmount());
  });

  it('AchievementsShowcase "earned on" label names the day the milestone was earned', () => {
    const renderer = render(<AchievementsShowcase snapshot={mockSnapshot} />);
    const copy = textNodes(renderer);
    // Day 1 and Day 3 badges are earned on the first and third trained days.
    for (const earnedDay of [TRAINED_DAYS[0], TRAINED_DAYS[2]]) {
      expect(mockSnapshot.earned.map(e => e.earnedOnDay)).toContain(earnedDay);
      expect(copy).toContain(expectedLabel(earnedDay, EARNED_OPTIONS));
      expect(copy).not.toContain(
        expectedLabel(nextDay(earnedDay), EARNED_OPTIONS),
      );
    }
    act(() => renderer.unmount());
  });
});
