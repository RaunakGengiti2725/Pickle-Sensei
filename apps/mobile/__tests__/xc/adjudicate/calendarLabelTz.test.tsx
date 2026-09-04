/**
 * Adjudication reproduction (xc-journeys / journey-progress-streaks): the
 * StreakCalendarScreen day-detail heading and the AchievementsShowcase
 * "Earned <date>" label must name the SAME calendar day as the engine's
 * YYYY-MM-DD key (the key the day cell exposes to assistive tech), in every
 * device zone. A label anchored at 12:00Z but formatted in the device zone
 * rolls to the NEXT day at UTC+12:01 and beyond (Pacific/Auckland during DST,
 * Tonga, Tokelau, Kiritimati, Apia).
 *
 * Jest inherits the process zone, so run once per zone:
 *   cd apps/mobile && TZ=Pacific/Auckland npx jest --ci __tests__/xc/adjudicate/calendarLabelTz.test.tsx
 *   cd apps/mobile && TZ=America/Los_Angeles npx jest --ci __tests__/xc/adjudicate/calendarLabelTz.test.tsx
 *   cd apps/mobile && TZ=UTC npx jest --ci __tests__/xc/adjudicate/calendarLabelTz.test.tsx
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { AchievementsShowcase } from '../../../src/consistency/AchievementsShowcase';
import {
  buildConsistencySnapshot,
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

// The engine keys days in ITS zone option, so the fixture is zone-stable:
// three consecutive Auckland (UTC+13, southern summer) evenings.
const ENGINE_ZONE = 'Pacific/Auckland';
const mockSnapshot: ConsistencySnapshot = buildConsistencySnapshot(
  ['2026-01-13', '2026-01-14', '2026-01-15'].map(day => ({
    kind: 'stroke' as const,
    // 18:00 Auckland local = 05:00Z same day.
    atIso: `${day}T05:00:00.000Z`,
    shotType: 'dink',
    overallScore: 7,
    resultKind: 'scored' as const,
  })),
  { asOfIso: '2026-01-15T05:00:00.000Z', timeZone: ENGINE_ZONE },
);
jest.mock('../../../src/consistency/store', () => ({
  useConsistencyStore: (selector: (state: unknown) => unknown) =>
    selector({
      snapshot: mockSnapshot,
      loadError: false,
      refresh: async () => undefined,
    }),
}));

import { StreakCalendarScreen } from '../../../src/screens/StreakCalendarScreen';

declare const process: { env: Record<string, string | undefined> };
const PROCESS_ZONE =
  process.env['TZ'] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
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

describe(`adjudication: calendar day labels in TZ=${PROCESS_ZONE}`, () => {
  it('engine fixture keys the run on 2026-01-15 regardless of the process zone', () => {
    expect(mockSnapshot.asOfDay).toBe('2026-01-15');
    expect(mockSnapshot.currentStreak).toBe(3);
    const kindling = mockSnapshot.earned.find(e => e.id === 'streak.3');
    expect(kindling?.earnedOnDay).toBe('2026-01-15');
  });

  it('names the engine day key in the AchievementsShowcase "Earned" label', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <AchievementsShowcase snapshot={mockSnapshot} />,
      );
    });
    const label = renderer.root
      .findAll(
        node =>
          typeof node.props.accessibilityLabel === 'string' &&
          node.props.accessibilityLabel.startsWith('Kindling. Earned'),
      )
      .map(node => String(node.props.accessibilityLabel))[0];
    act(() => renderer.unmount());

    console.log(
      `[adjudicate] TZ=${PROCESS_ZONE} engineDay=2026-01-15 earnedLabel="${label}"`,
    );
    expect(label).toBe('Kindling. Earned Jan 15');
  });

  it('names the engine day key in the StreakCalendarScreen day-detail heading', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<StreakCalendarScreen />);
    });
    // Trained today → today's log opens by itself (tapping would toggle it).
    const dayNode = renderer.root.findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('2026-01-15, trained') &&
        typeof node.props.onPress === 'function',
    )[0]!;
    expect(dayNode.props.accessibilityState).toMatchObject({ selected: true });
    const detail = renderer.root.findAll(
      node => node.props.testID === 'streak-day-detail',
    )[0]!;
    const headingNode = detail.findAllByType(Text)[0]!;
    const heading = String(headingNode.props.children);
    const copy = textOf(renderer);
    act(() => renderer.unmount());

    console.log(
      `[adjudicate] TZ=${PROCESS_ZONE} engineDay=2026-01-15 dayDetailHeading="${heading}"`,
    );
    expect(heading).toBe('Thursday, January 15');
    expect(copy).not.toContain('January 16');
  });
});
