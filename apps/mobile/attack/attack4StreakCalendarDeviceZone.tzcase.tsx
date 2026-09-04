/**
 * Adversarial pass 3 (tester #4) — device time zone vs. day-key labels.
 *
 * The engine keys days in the DEVICE zone, but the StreakCalendar day-detail
 * heading and the AchievementsShowcase "earned on" label format the key via
 * `new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, …)` — i.e. in
 * the device zone WITHOUT a timeZone option. For any device zone at UTC+12:00
 * or beyond (Pacific/Auckland in southern summer = +13, Fiji DST, Tonga,
 * Samoa, Kiribati) 12:00Z is already the NEXT calendar day, so the label
 * names the wrong day.
 *
 * Jest's sandbox cannot switch the process zone, so this file is NOT picked
 * up by the default `*.test.tsx` glob. Run it with the device zone set:
 *
 *   TZ=Pacific/Auckland npx jest --ci --runTestsByPath \
 *     __tests__/attack4StreakCalendarDeviceZone.tzcase.tsx
 */

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  buildConsistencySnapshot,
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

const mockState: { snapshot: ConsistencySnapshot | null } = { snapshot: null };
jest.mock('../src/consistency/store', () => ({
  useConsistencyStore: (selector: (state: unknown) => unknown) =>
    selector({
      snapshot: mockState.snapshot,
      loadError: false,
      refresh: jest.fn(async () => undefined),
    }),
}));

import { StreakCalendarScreen } from '../src/screens/StreakCalendarScreen';
import { AchievementsShowcase } from '../src/consistency/AchievementsShowcase';
import { PressableScale } from '../src/design/components';

const ZONE = 'Pacific/Auckland';

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

/** What the heading SHOULD say for a YYYY-MM-DD key, zone-independent. */
function expectedHeading(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function stroke(atIso: string): TrainingActivityInput {
  return {
    kind: 'stroke',
    atIso,
    shotType: 'dink',
    overallScore: 6,
    resultKind: 'scored',
  };
}

describe('attack4: device zone Pacific/Auckland (UTC+13 in January)', () => {
  // Sunday 2027-01-10 in Auckland. 09:00 local = 2027-01-09T20:00Z.
  const asOfIso = '2027-01-10T08:00:00.000Z'; // 21:00 local, Jan 10
  const activities = [
    stroke('2027-01-07T20:00:00.000Z'), // Jan 8 local
    stroke('2027-01-08T20:00:00.000Z'), // Jan 9 local
    stroke('2027-01-09T20:00:00.000Z'), // Jan 10 local
  ];

  beforeAll(() => {
    // Prove the process really is in the target zone before trusting any
    // assertion below.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(ZONE);
    expect(new Date('2027-01-10T12:00:00Z').getTimezoneOffset()).toBe(-780);
  });

  beforeEach(() => {
    mockState.snapshot = buildConsistencySnapshot(activities, {
      asOfIso,
      timeZone: ZONE,
    });
  });

  it('engine keys the days in the device zone (precondition)', () => {
    const snapshot = mockState.snapshot!;
    expect(snapshot.asOfDay).toBe('2027-01-10');
    expect(Object.keys(snapshot.days).sort()).toEqual([
      '2027-01-08',
      '2027-01-09',
      '2027-01-10',
    ]);
    expect(snapshot.trainedToday).toBe(true);
  });

  it('the selected-day heading names the same calendar day as the tapped cell', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<StreakCalendarScreen />);
    });
    // Today auto-selected → heading should be "Sunday, January 10".
    const detail = renderer.root.findAll(
      node =>
        node.props.testID === 'streak-day-detail' &&
        String(node.type) === 'View',
    );
    expect(detail).toHaveLength(1);
    const headingText = allText(renderer);
    const wanted = expectedHeading('2027-01-10');
    expect(wanted).toBe('Sunday, January 10');
    expect(headingText).toContain(wanted);
    expect(headingText).not.toContain('Monday, January 11');

    // Tap Jan 8 and re-check.
    const jan8 = renderer.root
      .findAllByType(PressableScale)
      .filter(
        node =>
          typeof node.props.accessibilityLabel === 'string' &&
          node.props.accessibilityLabel.startsWith('2027-01-08'),
      )[0]!;
    await act(async () => {
      jan8.props.onPress();
    });
    const after = allText(renderer);
    expect(after).toContain(expectedHeading('2027-01-08'));
    expect(after).not.toContain('Saturday, January 9');
    act(() => renderer.unmount());
  });

  it('AchievementsShowcase "earned on" label names the day the milestone was earned', () => {
    const snapshot = mockState.snapshot!;
    const streak1 = snapshot.earned.find(entry => entry.id === 'streak.1');
    expect(streak1?.earnedOnDay).toBe('2027-01-08');
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <AchievementsShowcase snapshot={snapshot} />,
      );
    });
    // The earned badge renders its "earned on" meta inline and repeats it in
    // the accessibility label.
    const copy = allText(renderer);
    expect(copy).toMatch(/Jan \d/);
    expect(copy).toContain('Jan 8');
    expect(copy).not.toContain('Jan 9');
    const labels = renderer.root
      .findAllByType(PressableScale)
      .map(node => node.props.accessibilityLabel as string)
      .filter(label => label.includes('Earned'));
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.some(label => label.includes('Jan 8'))).toBe(true);
    expect(labels.some(label => label.includes('Jan 9'))).toBe(false);
    act(() => renderer.unmount());
  });
});
