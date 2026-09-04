/**
 * xc journey-progress-streaks — StreakCalendarScreen / AchievementsShowcase
 * date labels, grid alignment, long names and RTL, evaluated in the PROCESS
 * time zone (`TZ`). Run once per zone with
 *   node scripts/xc-journey-progress-streaks/run-tz-processes.mjs
 * which spawns jest with TZ=<zone> and collects
 * artifacts/xc-journey-progress-streaks/calendar-labels.<zone>.json.
 *
 * Contract under test: the day-detail heading and the achievement "Earned …"
 * label must name the SAME calendar day as the YYYY-MM-DD key the engine
 * produced (the key the day cell exposes to assistive tech).
 */
import React from 'react';
import { I18nManager, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  buildConsistencySnapshot,
  type ConsistencySnapshot,
} from '../../src/consistency/engine';
import { AchievementsShowcase } from '../../src/consistency/AchievementsShowcase';
import {
  nodeEnv,
  nodeVersion,
  processZone,
  resolveWallClock,
  wallClock,
  writeArtifact,
} from '../../scripts/xc-journey-progress-streaks/oracle';

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

let mockSnapshot: ConsistencySnapshot | null = null;
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (state: {
      snapshot: ConsistencySnapshot | null;
      loadError: boolean;
      refresh: () => Promise<void>;
    }) => unknown,
  ) =>
    selector({
      snapshot: mockSnapshot,
      loadError: false,
      refresh: async () => undefined,
    }),
}));

import { StreakCalendarScreen } from '../../src/screens/StreakCalendarScreen';

const ZONE = processZone();
const OFFSET_MIN = -new Date('2026-03-31T12:00:00Z').getTimezoneOffset();

const LONG_TECHNIQUE =
  'third_shot_drop_with_extended_follow_through_and_recovery_split_step_from_the_transition_zone_into_the_kitchen_line';
const LONG_DRILL =
  'Kitchen-line dink ladder — forty consecutive cross-court dinks alternating forehand and backhand without a pop-up, then reset';

/** Correct rendering of a YYYY-MM-DD key, independent of the device zone. */
function expectedLongLabel(day: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${day}T12:00:00Z`));
}
function expectedShortLabel(day: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${day}T12:00:00Z`));
}

/** A snapshot whose asOf is TODAY-in-ZONE at 20:00 wall clock, with three
 * straight trained days (streak.1 + streak.3 earned). */
function threeDaySnapshot(asOfDay: string): ConsistencySnapshot {
  const at = (day: string, hour: number) =>
    new Date(
      resolveWallClock(wallClock(day, hour), ZONE).instants[0]!,
    ).toISOString();
  const dayMinus = (n: number) => {
    const d = new Date(`${asOfDay}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  return buildConsistencySnapshot(
    [
      {
        kind: 'stroke',
        atIso: at(dayMinus(2), 9),
        shotType: 'dink',
        overallScore: 6.2,
        resultKind: 'scored',
      },
      {
        kind: 'stroke',
        atIso: at(dayMinus(1), 23),
        shotType: LONG_TECHNIQUE,
        overallScore: 7.4,
        resultKind: 'scored',
      },
      {
        kind: 'stroke',
        atIso: at(asOfDay, 0),
        shotType: 'serve',
        overallScore: 8.1,
        resultKind: 'scored',
      },
      { kind: 'drill', atIso: at(asOfDay, 19), label: LONG_DRILL },
    ],
    { asOfIso: at(asOfDay, 20), timeZone: ZONE },
  );
}

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map(node =>
    React.Children.toArray(node.props.children)
      .filter(
        (c): c is string | number =>
          typeof c === 'string' || typeof c === 'number',
      )
      .join(''),
  );
}

interface LabelRecord {
  zone: string;
  offsetMinutes: number;
  asOfDay: string;
  detailHeading: string;
  expectedHeading: string;
  headingMatches: boolean;
  earnedLabel: string;
  expectedEarned: string;
  earnedMatches: boolean;
}

const records: LabelRecord[] = [];
const gridRecords: Array<{
  month: string;
  leadCells: number;
  expectedLead: number;
}> = [];
let rtlRendered = false;
let longNameRendered = false;

afterAll(() => {
  writeArtifact(
    `calendar-labels.${(nodeEnv.TZ ?? ZONE).replace(/\//g, '_')}.json`,
    {
      zone: ZONE,
      offsetMinutesAt2026_03_31: OFFSET_MIN,
      node: nodeVersion,
      labelCases: records,
      gridCases: gridRecords,
      rtlRendered,
      longNameRendered,
      failures: records.filter(r => !r.headingMatches || !r.earnedMatches),
    },
  );
});

describe(`xc journey-progress-streaks: calendar labels in TZ=${ZONE} (offset ${OFFSET_MIN} min)`, () => {
  // Days that surround a month end, a year end, and the leap day.
  const asOfDays = [
    '2026-03-31',
    '2026-04-01',
    '2025-12-31',
    '2026-01-01',
    '2028-02-29',
    '2026-08-15',
  ];

  it.each(asOfDays)(
    'day-detail heading and Earned label name the engine day key (%s)',
    asOfDay => {
      const snapshot = threeDaySnapshot(asOfDay);
      expect(snapshot.asOfDay).toBe(asOfDay);
      expect(snapshot.trainedToday).toBe(true);
      mockSnapshot = snapshot;
      const renderer = render(<StreakCalendarScreen />);
      const detail = renderer.root.findAllByProps({
        testID: 'streak-day-detail',
      })[0]!;
      const heading = detail.findAllByType(Text)[0]!;
      const headingText = React.Children.toArray(heading.props.children).join(
        '',
      );
      const dayCell = renderer.root.findAll(
        node =>
          typeof node.props.accessibilityLabel === 'string' &&
          node.props.accessibilityLabel.startsWith(`${asOfDay}, trained`) &&
          typeof node.props.accessibilityState === 'object',
      )[0];
      expect(dayCell).toBeDefined();
      act(() => renderer.unmount());

      const showcase = render(<AchievementsShowcase snapshot={snapshot} />);
      const kindling = showcase.root.findAll(
        node =>
          typeof node.props.accessibilityLabel === 'string' &&
          node.props.accessibilityLabel.startsWith('Kindling. Earned'),
      )[0]!;
      const earnedLabel = (kindling.props.accessibilityLabel as string).replace(
        'Kindling. Earned ',
        '',
      );
      act(() => showcase.unmount());

      const record: LabelRecord = {
        zone: ZONE,
        offsetMinutes: OFFSET_MIN,
        asOfDay,
        detailHeading: headingText,
        expectedHeading: expectedLongLabel(asOfDay),
        headingMatches: headingText === expectedLongLabel(asOfDay),
        earnedLabel,
        expectedEarned: expectedShortLabel(asOfDay),
        earnedMatches: earnedLabel === expectedShortLabel(asOfDay),
      };
      records.push(record);
      expect(record.detailHeading).toBe(record.expectedHeading);
      expect(record.earnedLabel).toBe(record.expectedEarned);
    },
  );

  it('places the 1st of every month in the Monday-first column the oracle expects, regardless of TZ', () => {
    for (let month = 0; month < 12; month += 1) {
      const key = `2026-${String(month + 1).padStart(2, '0')}-01`;
      const snapshot = buildConsistencySnapshot(
        [
          {
            kind: 'stroke',
            atIso: new Date(
              resolveWallClock(wallClock(key, 12), ZONE).instants[0]!,
            ).toISOString(),
          },
        ],
        {
          asOfIso: new Date(
            resolveWallClock(wallClock(key, 13), ZONE).instants[0]!,
          ).toISOString(),
          timeZone: ZONE,
        },
      );
      mockSnapshot = snapshot;
      const renderer = render(<StreakCalendarScreen />);
      // Week rows: host Views whose seven children are DayCell elements
      // (each carries a `cell` prop; blank lead cells have `cell.day === null`).
      const weekRows = renderer.root.findAll(
        node =>
          (node.type as unknown) === 'View' &&
          node.children.length === 7 &&
          node.children.every(
            child => typeof child !== 'string' && 'cell' in child.props,
          ),
      );
      const firstWeek = weekRows.find(row =>
        row.children.some(
          child => typeof child !== 'string' && child.props.cell.day === key,
        ),
      )!;
      expect(firstWeek).toBeDefined();
      const leadCells = firstWeek.children.findIndex(
        child => typeof child !== 'string' && child.props.cell.day !== null,
      );
      // ISO weekday of the 1st (Mon=0 … Sun=6) computed from the key alone.
      const expectedLead = (new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7;
      gridRecords.push({ month: key.slice(0, 7), leadCells, expectedLead });
      expect(leadCells).toBe(expectedLead);
      act(() => renderer.unmount());
    }
  });

  it('renders very long technique/drill names on one truncating line with the full text intact', () => {
    const snapshot = threeDaySnapshot('2026-03-31');
    mockSnapshot = snapshot;
    const renderer = render(<StreakCalendarScreen />);
    const labels = renderer.root
      .findAllByType(Text)
      .filter(node => node.props.numberOfLines === 1);
    const drill = labels.find(node => node.props.children === LONG_DRILL);
    expect(drill).toBeDefined();
    // Yesterday's long technique shows once that day is selected.
    const yesterday = renderer.root.findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('2026-03-30, trained') &&
        typeof node.props.onPress === 'function',
    )[0]!;
    act(() => yesterday.props.onPress());
    const technique = renderer.root
      .findAllByType(Text)
      .find(node => node.props.children === LONG_TECHNIQUE.replace(/_/g, ' '));
    expect(technique).toBeDefined();
    expect(technique!.props.numberOfLines).toBe(1);
    longNameRendered = true;
    act(() => renderer.unmount());
  });

  it('renders under RTL with the grid still seven cells wide and labels intact', () => {
    const original = I18nManager.isRTL;
    Object.defineProperty(I18nManager, 'isRTL', {
      value: true,
      configurable: true,
    });
    try {
      mockSnapshot = threeDaySnapshot('2026-03-31');
      const renderer = render(<StreakCalendarScreen />);
      const weekday = texts(renderer);
      expect(weekday.join(' ')).toContain('M T W T F S S');
      const rows = renderer.root.findAll(
        node =>
          (node.type as unknown) === 'View' &&
          node.children.length === 7 &&
          node.children.every(
            child => typeof child !== 'string' && 'cell' in child.props,
          ),
      );
      expect(rows.length).toBeGreaterThanOrEqual(5);
      expect(
        renderer.root.findAll(
          n =>
            typeof n.props.accessibilityLabel === 'string' &&
            n.props.accessibilityLabel.startsWith('2026-03-31, trained'),
        ).length,
      ).toBeGreaterThan(0);
      rtlRendered = true;
      act(() => renderer.unmount());
    } finally {
      Object.defineProperty(I18nManager, 'isRTL', {
        value: original,
        configurable: true,
      });
    }
  });
});
