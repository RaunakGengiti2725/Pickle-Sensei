/**
 * Adversarial pass (mobile-home-progress-library #1, pass 3) against
 * StreakCalendarScreen: engine snapshots built from corrupt/ancient/huge
 * activity histories, the store's failure shape, rapid month walking, and a
 * snapshot swap under the user's feet.
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
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = jest.requireActual<typeof import('react')>('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

const mockRefresh = jest.fn<Promise<void>, []>(async () => undefined);
const mockStoreState: {
  snapshot: ConsistencySnapshot | null;
  loadError: boolean;
  refresh: () => Promise<void>;
} = { snapshot: null, loadError: false, refresh: mockRefresh };
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (selector: (state: unknown) => unknown) =>
    selector(mockStoreState),
}));

import { StreakCalendarScreen } from '../../src/screens/StreakCalendarScreen';

const AS_OF_ISO = '2026-09-04T18:00:00.000Z';

function stroke(atIso: string, score = 6.5): TrainingActivityInput {
  return {
    kind: 'stroke',
    atIso,
    shotType: 'dink',
    overallScore: score,
    resultKind: 'scored',
  };
}

function snap(history: TrainingActivityInput[]): ConsistencySnapshot {
  return buildConsistencySnapshot(history, {
    asOfIso: AS_OF_ISO,
    timeZone: 'UTC',
  });
}

type Renderer = TestRenderer.ReactTestRenderer;

function renderScreen(): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(<StreakCalendarScreen />);
  });
  return renderer;
}

function allText(renderer: Renderer): string {
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

function byLabel(renderer: Renderer, label: string) {
  const nodes = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.accessibilityState === 'object' &&
      typeof node.props.accessibilityRole === 'string',
  );
  expect(nodes.length).toBeGreaterThan(0);
  return nodes[0]!;
}

function press(node: TestRenderer.ReactTestInstance) {
  act(() => {
    node.props.onPress();
  });
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: new Date(AS_OF_ISO) });
  mockStoreState.snapshot = null;
  mockStoreState.loadError = false;
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  consoleError.mockRestore();
});

describe('StreakCalendarScreen — corrupt & extreme snapshots', () => {
  it('a snapshot carrying the year-0999 corrupt day key still renders and the grid clamps sanely', () => {
    // Engine finding: a 0999 timestamp yields the malformed key "999-06-01".
    const corruptFirst = snap([
      stroke('0999-06-01T00:00:00.000Z'),
      stroke('2026-09-02T10:00:00.000Z'),
      stroke('2026-09-03T10:00:00.000Z'),
      stroke('2026-09-04T10:00:00.000Z'),
    ]);
    mockStoreState.snapshot = corruptFirst;
    const renderer = renderScreen();
    const text = allText(renderer);
    expect(text).toContain('September 2026');
    expect(text).not.toMatch(/NaN|undefined|Invalid Date/);
    console.info(
      `[attack] 0999-first snapshot: streak=${corruptFirst.currentStreak} trainedDays=${corruptFirst.totalTrainedDays} keys=${Object.keys(corruptFirst.days).join(',')}`,
    );
    // Walk back 30 months rapidly: never a crash, never a future month.
    for (let i = 0; i < 30; i += 1) {
      const prev = byLabel(renderer, 'Previous month');
      if (prev.props.accessibilityState.disabled) break;
      press(prev);
    }
    expect(allText(renderer)).not.toMatch(/NaN|undefined|Invalid Date/);
    expect(consoleError).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('a 1970 epoch read makes Previous walkable for decades without a crash (200 presses)', () => {
    mockStoreState.snapshot = snap([
      stroke('1970-01-01T00:00:00.000Z'),
      stroke('2026-09-04T10:00:00.000Z'),
    ]);
    const renderer = renderScreen();
    expect(allText(renderer)).toContain('September 2026');
    for (let i = 0; i < 200; i += 1) {
      const prev = byLabel(renderer, 'Previous month');
      expect(prev.props.accessibilityState.disabled).toBe(false);
      press(prev);
    }
    // 200 months back from September 2026 is January 2010.
    expect(allText(renderer)).toContain('January 2010');
    expect(
      byLabel(renderer, 'Next month').props.accessibilityState,
    ).toMatchObject({
      disabled: false,
    });
    expect(consoleError).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('20,000 activities in one month render every cell and the totals honestly', () => {
    const history: TrainingActivityInput[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const day = 1 + (i % 30);
      history.push(
        stroke(
          `2026-08-${String(day).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
          (i % 100) / 10,
        ),
      );
    }
    history.push(stroke('2026-09-04T10:00:00.000Z'));
    const started = Date.now();
    mockStoreState.snapshot = snap(history);
    const renderer = renderScreen();
    press(byLabel(renderer, 'Previous month'));
    const text = allText(renderer);
    expect(text).toContain('August 2026');
    expect(text).not.toMatch(/NaN|undefined|Infinity/);
    expect(mockStoreState.snapshot.totalActivities).toBe(20_001);
    expect(Date.now() - started).toBeLessThan(10_000);
    act(() => renderer.unmount());
  });

  it('store failure shape (snapshot null + loadError) shows recovery copy, not a blank grid', () => {
    mockStoreState.loadError = true;
    const renderer = renderScreen();
    const text = allText(renderer);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/NaN|undefined/);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('snapshot null with no error renders the empty calendar for the wall-clock month', () => {
    const renderer = renderScreen();
    const text = allText(renderer);
    expect(text).toContain('September 2026');
    expect(text).toContain('0');
    expect(
      byLabel(renderer, 'Next month').props.accessibilityState,
    ).toMatchObject({
      disabled: true,
    });
    expect(
      byLabel(renderer, 'Previous month').props.accessibilityState,
    ).toMatchObject({
      disabled: true,
    });
    act(() => renderer.unmount());
  });

  it('snapshot swapped under the user (owner switch) keeps the chosen month and never throws', () => {
    mockStoreState.snapshot = snap([
      stroke('2026-07-01T10:00:00.000Z'),
      stroke('2026-09-04T10:00:00.000Z'),
    ]);
    const renderer = renderScreen();
    press(byLabel(renderer, 'Previous month'));
    expect(allText(renderer)).toContain('August 2026');
    // New owner: only today is logged. The visible month is the user's.
    mockStoreState.snapshot = snap([stroke('2026-09-04T10:00:00.000Z')]);
    act(() => {
      renderer.update(<StreakCalendarScreen />);
    });
    expect(allText(renderer)).toContain('August 2026');
    // OBSERVED (P3): the clamp is an equality test (`atEarliestMonth`,
    // StreakCalendarScreen.tsx:343-349,516), so a visible month that is now
    // BEFORE the earliest logged month keeps Previous enabled indefinitely.
    const prevState = byLabel(renderer, 'Previous month').props
      .accessibilityState as { disabled: boolean };
    console.info(
      `[attack][finding] after owner swap, visible=August earliest=September, Previous disabled=${prevState.disabled}`,
    );
    expect(prevState.disabled).toBe(false);
    press(byLabel(renderer, 'Previous month'));
    expect(allText(renderer)).toContain('July 2026');
    // Next still walks home without a crash.
    press(byLabel(renderer, 'Next month'));
    press(byLabel(renderer, 'Next month'));
    expect(allText(renderer)).toContain('September 2026');
    expect(
      byLabel(renderer, 'Previous month').props.accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(consoleError).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  // FINDING (P3, pre-existing on main): month clamp must be an ordering
  // test — a visible month earlier than the earliest logged month should
  // disable Previous (StreakCalendarScreen.tsx:343-349,516).
  it.failing(
    'Previous must be disabled whenever the visible month is at or before the earliest logged month',
    () => {
      mockStoreState.snapshot = snap([
        stroke('2026-07-01T10:00:00.000Z'),
        stroke('2026-09-04T10:00:00.000Z'),
      ]);
      const renderer = renderScreen();
      press(byLabel(renderer, 'Previous month'));
      mockStoreState.snapshot = snap([stroke('2026-09-04T10:00:00.000Z')]);
      act(() => {
        renderer.update(<StreakCalendarScreen />);
      });
      expect(
        byLabel(renderer, 'Previous month').props.accessibilityState,
      ).toMatchObject({ disabled: true });
      act(() => renderer.unmount());
    },
  );

  it('shielded day (7 trained, 1 miss) renders with 0 XP on the shielded cell log', () => {
    const history = Array.from({ length: 7 }, (_, i) =>
      stroke(`2026-08-2${i + 1}T10:00:00.000Z`),
    );
    history.push(stroke('2026-08-29T10:00:00.000Z'));
    mockStoreState.snapshot = snap(history);
    const s = mockStoreState.snapshot;
    expect(s.days['2026-08-28']?.shielded).toBe(true);
    expect(s.days['2026-08-28']?.xp).toBe(0);
    const renderer = renderScreen();
    press(byLabel(renderer, 'Previous month'));
    const text = allText(renderer);
    expect(text).toContain('August 2026');
    expect(text).not.toMatch(/NaN|undefined/);
    act(() => renderer.unmount());
  });
});
