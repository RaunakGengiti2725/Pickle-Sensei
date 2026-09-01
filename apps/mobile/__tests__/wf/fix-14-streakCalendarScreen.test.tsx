import React from 'react';
import { StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  buildConsistencySnapshot,
  type ConsistencySnapshot,
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
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn() }),
  useFocusEffect: () => {},
}));

interface MockConsistencyState {
  snapshot: ConsistencySnapshot | null;
  loadError: boolean;
  refresh: jest.Mock<Promise<void>, []>;
}

const mockRefresh = jest.fn(async () => undefined);
const mockListeners = new Set<() => void>();
let mockState: MockConsistencyState = {
  snapshot: null,
  loadError: false,
  refresh: mockRefresh,
};

function setMockState(patch: Partial<MockConsistencyState>) {
  mockState = { ...mockState, ...patch };
  for (const listener of mockListeners) listener();
}

jest.mock('../../src/consistency/store', () => {
  const ReactModule = require('react') as typeof import('react');
  return {
    useConsistencyStore: (
      selector: (state: MockConsistencyState) => unknown,
    ) => {
      const [, force] = ReactModule.useState(0);
      ReactModule.useEffect(() => {
        const listener = () => force(v => v + 1);
        mockListeners.add(listener);
        return () => {
          mockListeners.delete(listener);
        };
      }, []);
      return selector(mockState);
    },
  };
});

import { StreakCalendarScreen } from '../../src/screens/StreakCalendarScreen';

const LA_SNAPSHOT = buildConsistencySnapshot(
  [
    {
      kind: 'stroke',
      atIso: '2026-03-31T20:00:00.000Z',
      shotType: 'serve',
      overallScore: 7.2,
      resultKind: 'scored',
    },
  ],
  { asOfIso: '2026-04-01T04:00:00.000Z', timeZone: 'America/Los_Angeles' },
);

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

function findByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.accessibilityState === 'object' &&
      typeof node.props.onPress === 'function',
  )[0]!;
}

beforeEach(() => {
  mockRefresh.mockClear();
  mockGoBack.mockClear();
  mockState = { snapshot: null, loadError: false, refresh: mockRefresh };
});

describe('StreakCalendarScreen buttons (wf ledger)', () => {
  it('gives both month arrows a hit target of at least 44pt', () => {
    setMockState({ snapshot: LA_SNAPSHOT });
    const renderer = renderScreen();
    for (const label of ['Previous month', 'Next month']) {
      const host = renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          node.props.accessibilityLabel === label,
      )[0]!;
      const flat = StyleSheet.flatten(host.props.style) as {
        width?: number;
        height?: number;
      };
      const hitSlop = Number(host.props.hitSlop ?? 0);
      expect(flat.width! + 2 * hitSlop).toBeGreaterThanOrEqual(44);
      expect(flat.height! + 2 * hitSlop).toBeGreaterThanOrEqual(44);
    }
    act(() => renderer.unmount());
  });

  it('exposes the open day as selected to assistive tech and toggles it', async () => {
    setMockState({ snapshot: LA_SNAPSHOT });
    const renderer = renderScreen();
    const findDay = () =>
      renderer.root.findAll(
        node =>
          typeof node.props.accessibilityLabel === 'string' &&
          node.props.accessibilityLabel.startsWith('2026-03-31, trained') &&
          typeof node.props.accessibilityState === 'object',
      )[0]!;
    expect(findDay().props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(findDay().props.disabled).toBeFalsy();
    await act(async () => {
      findDay().props.onPress();
    });
    expect(findDay().props.accessibilityState).toMatchObject({
      selected: false,
    });
    expect(
      renderer.root.findAllByProps({ testID: 'streak-day-detail' }),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('shows an honest error with a live Try again when the history load failed', async () => {
    setMockState({ snapshot: null, loadError: true });
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy).toContain('Couldn’t load your training history');
    expect(copy).not.toContain('DAY STREAK');
    expect(copy).not.toContain('Your first analysis lights the flame.');
    const retry = findByLabel(renderer, 'Try again');
    expect(retry.props.accessibilityState.disabled).toBeFalsy();
    await act(async () => {
      retry.props.onPress();
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      setMockState({ snapshot: LA_SNAPSHOT, loadError: false });
    });
    expect(allText(renderer)).toContain('1 DAY STREAK');
    expect(allText(renderer)).not.toContain('Couldn’t load');
    act(() => renderer.unmount());
  });

  it('keeps the fresh-user copy when there is no history and no error', () => {
    setMockState({ snapshot: null, loadError: false });
    const renderer = renderScreen();
    const copy = allText(renderer);
    expect(copy).toContain('Your first analysis lights the flame.');
    expect(copy).not.toContain('Couldn’t load');
    expect(
      findByLabel(renderer, 'Next month').props.accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(
      findByLabel(renderer, 'Previous month').props.accessibilityState,
    ).toMatchObject({ disabled: true });
    act(() => renderer.unmount());
  });

  describe('month anchoring across the UTC/local month boundary', () => {
    beforeEach(() => {
      jest.useFakeTimers({ now: new Date('2026-04-01T04:00:00.000Z') });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('re-anchors to the snapshot month when the snapshot lands after mount', async () => {
      const renderer = renderScreen();
      await act(async () => {
        setMockState({ snapshot: LA_SNAPSHOT });
      });
      const copy = allText(renderer);
      expect(copy).toContain('March 2026');
      expect(copy).not.toContain('April 2026');
      expect(copy).toContain('Tuesday, March 31');
      expect(
        findByLabel(renderer, 'Next month').props.accessibilityState,
      ).toMatchObject({ disabled: true });
      act(() => renderer.unmount());
    });

    it('anchors on the snapshot month when it is already loaded at mount', () => {
      setMockState({ snapshot: LA_SNAPSHOT });
      const renderer = renderScreen();
      const copy = allText(renderer);
      expect(copy).toContain('March 2026');
      expect(copy).not.toContain('April 2026');
      act(() => renderer.unmount());
    });
  });
});
