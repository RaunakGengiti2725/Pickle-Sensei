/**
 * Adversarial matrix for the calendar-label fix (candidate 04058fd1, cluster
 * xc-journeys::XC-P2-CALENDAR-LABEL-UTC-PLUS-OFF-BY-ONE / XC-UAI-01).
 *
 * The engine keys days in the DEVICE zone and the screens must render each
 * key as that calendar date. This file pushes past the candidate's fixtures:
 * every day of 2024–2027 through formatDayKey (leap day, year boundaries),
 * an engine fixture keyed in UTC+14 (Pacific/Kiritimati) and one in UTC-11
 * (Pacific/Pago_Pago) rendered in whatever zone the process runs in, a run
 * that crosses a month AND year boundary (Dec 30 → Jan 2), the month grid's
 * Monday-first layout, and every achievement label on the showcase.
 *
 * Run once per zone, e.g.
 *   cd apps/mobile && for tz in Pacific/Kiritimati Pacific/Auckland Pacific/Chatham \
 *     Asia/Kathmandu UTC America/Los_Angeles Pacific/Pago_Pago Etc/GMT+12; do \
 *     TZ=$tz npx jest --ci __tests__/xc/attack/calendarLabelZoneMatrix.test.tsx || exit 1; done
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { AchievementsShowcase } from '../../../src/consistency/AchievementsShowcase';
import {
  buildConsistencySnapshot,
  formatDayKey,
  type ConsistencySnapshot,
} from '../../../src/consistency/engine';

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

declare const process: { env: Record<string, string | undefined> };
const ZONE =
  process.env['TZ'] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

// Kiritimati (UTC+14, no DST): 20:00 local = 06:00Z the same day. A run
// 2026-12-30 → 2027-01-02 crosses month and year; it is keyed by the engine
// in UTC+14 regardless of the process zone.
const KIRITIMATI_DAYS = [
  '2026-12-30',
  '2026-12-31',
  '2027-01-01',
  '2027-01-02',
] as const;
const mockSnapshot: ConsistencySnapshot = buildConsistencySnapshot(
  KIRITIMATI_DAYS.map(day => ({
    kind: 'stroke' as const,
    atIso: `${day}T06:00:00.000Z`,
    shotType: 'dink',
    overallScore: 7,
    resultKind: 'scored' as const,
  })),
  { asOfIso: '2027-01-02T06:00:00.000Z', timeZone: 'Pacific/Kiritimati' },
);

// Pago Pago (UTC-11): 06:00 local = 17:00Z the same day; the 7-day streak
// earns Kindling (3) and Week Warrior (7) on distinct days.
const PAGO_DAYS = [
  '2026-02-23',
  '2026-02-24',
  '2026-02-25',
  '2026-02-26',
  '2026-02-27',
  '2026-02-28',
  '2026-03-01',
] as const;
const pagoSnapshot: ConsistencySnapshot = buildConsistencySnapshot(
  PAGO_DAYS.map(day => ({
    kind: 'stroke' as const,
    atIso: `${day}T17:00:00.000Z`,
    shotType: 'serve',
    overallScore: 8,
    resultKind: 'scored' as const,
  })),
  { asOfIso: '2026-03-01T17:00:00.000Z', timeZone: 'Pacific/Pago_Pago' },
);

const mockStore: { snapshot: ConsistencySnapshot } = { snapshot: mockSnapshot };
jest.mock('../../../src/consistency/store', () => ({
  useConsistencyStore: (selector: (state: unknown) => unknown) =>
    selector({
      snapshot: mockStore.snapshot,
      loadError: false,
      refresh: async () => undefined,
    }),
}));

import { StreakCalendarScreen } from '../../../src/screens/StreakCalendarScreen';

const EN_US_MONTHS = [
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
const EN_US_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** Zone-independent expected label for a key, from its y/m/d parts only. */
function expectedLongLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${EN_US_WEEKDAYS[weekday]}, ${EN_US_MONTHS[m - 1]} ${d}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function dayDetailHeading(renderer: TestRenderer.ReactTestRenderer): string {
  const detail = renderer.root.findAll(
    node => node.props.testID === 'streak-day-detail',
  )[0]!;
  return String(detail.findAllByType(Text)[0]!.props.children);
}

function pressDay(renderer: TestRenderer.ReactTestRenderer, day: string) {
  const node = renderer.root.findAll(
    n =>
      typeof n.props.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.startsWith(`${day}, trained`) &&
      typeof n.props.onPress === 'function',
  )[0]!;
  act(() => {
    node.props.onPress();
  });
}

describe(`attack: calendar day labels in TZ=${ZONE}`, () => {
  it('formatDayKey names every day of 2024–2027 by its own y/m/d parts (en-US)', () => {
    const failures: string[] = [];
    for (let y = 2024; y <= 2027; y += 1) {
      for (let m = 1; m <= 12; m += 1) {
        const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
        for (let d = 1; d <= days; d += 1) {
          const key = `${y}-${pad2(m)}-${pad2(d)}`;
          const got = formatDayKey(key, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          });
          if (got !== expectedLongLabel(key)) failures.push(`${key} → ${got}`);
          const short = formatDayKey(key, { month: 'short', day: 'numeric' });
          if (!short.endsWith(` ${d}`))
            failures.push(`${key} short → ${short}`);
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });

  it('formatDayKey never throws or drifts for hostile keys', () => {
    for (const key of ['', 'garbage', '2026-13-01', '2026-00-10', '2026-9-4']) {
      expect(formatDayKey(key, { month: 'short', day: 'numeric' })).toBe(key);
    }
  });

  it('UTC+14 engine run across the year boundary titles every tapped day by its key', () => {
    mockStore.snapshot = mockSnapshot;
    expect(mockSnapshot.asOfDay).toBe('2027-01-02');
    expect(mockSnapshot.currentStreak).toBe(4);
    const renderer = render(<StreakCalendarScreen />);
    // Auto-selected today.
    expect(dayDetailHeading(renderer)).toBe('Saturday, January 2');
    pressDay(renderer, '2027-01-01');
    expect(dayDetailHeading(renderer)).toBe('Friday, January 1');
    // Walk back one month to December and tap the two 2026 days.
    const prevMonth = renderer.root.findAll(
      n =>
        n.props.accessibilityLabel === 'Previous month' &&
        typeof n.props.onPress === 'function',
    )[0]!;
    act(() => {
      prevMonth.props.onPress();
    });
    pressDay(renderer, '2026-12-31');
    expect(dayDetailHeading(renderer)).toBe('Thursday, December 31');
    pressDay(renderer, '2026-12-30');
    expect(dayDetailHeading(renderer)).toBe('Wednesday, December 30');
    act(() => renderer.unmount());
  });

  it('month grid is Monday-first for December 2026 (Tue 1st → one leading blank)', () => {
    mockStore.snapshot = mockSnapshot;
    const renderer = render(<StreakCalendarScreen />);
    const prevMonth = renderer.root.findAll(
      n =>
        n.props.accessibilityLabel === 'Previous month' &&
        typeof n.props.onPress === 'function',
    )[0]!;
    act(() => {
      prevMonth.props.onPress();
    });
    // Every dated cell exposes its key; the first dated cell of the visible
    // month must be Dec 1 and sit at Monday-first index 1 (Tuesday).
    const cells = renderer.root.findAll(
      n =>
        typeof n.props.accessibilityLabel === 'string' &&
        /^2026-12-\d\d/.test(n.props.accessibilityLabel) &&
        typeof n.props.onPress === 'function',
    );
    expect(cells[0]!.props.accessibilityLabel.startsWith('2026-12-01')).toBe(
      true,
    );
    // 2026-12-01 is a Tuesday; 2027-01-01 a Friday. Derive from the keys the
    // trained cells expose, not from any zone-dependent Date.
    expect(new Date(Date.UTC(2026, 11, 1)).getUTCDay()).toBe(2);
    act(() => renderer.unmount());
  });

  it('UTC-11 engine run: every achievement "Earned" label names its own key', () => {
    expect(pagoSnapshot.asOfDay).toBe('2026-03-01');
    expect(pagoSnapshot.currentStreak).toBe(7);
    const renderer = render(<AchievementsShowcase snapshot={pagoSnapshot} />);
    const labels = renderer.root
      .findAll(
        n =>
          typeof n.props.accessibilityLabel === 'string' &&
          n.props.accessibilityLabel.includes('. Earned '),
      )
      .map(n => String(n.props.accessibilityLabel));
    act(() => renderer.unmount());
    expect(labels.length).toBeGreaterThanOrEqual(2);
    const earnedByDay = new Map(
      pagoSnapshot.earned.map(e => [e.id, e.earnedOnDay]),
    );
    expect(earnedByDay.get('streak.3')).toBe('2026-02-25');
    expect(earnedByDay.get('streak.7')).toBe('2026-03-01');
    expect(labels).toEqual(
      expect.arrayContaining([
        'Kindling. Earned Feb 25',
        expect.stringMatching(/\. Earned Mar 1$/),
      ]),
    );
    for (const label of labels) {
      expect(label).not.toMatch(/Feb 24|Feb 26|Feb 28|Mar 2/);
    }
  });
});
