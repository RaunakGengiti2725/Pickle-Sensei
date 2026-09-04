/**
 * Execution-audit harness (mobile-home-progress-library, pass 2).
 *
 * Covers the two consistency modules every shipped suite mocks away:
 * - `useConsistencyBootstrap` (0% covered at baseline): hydrates per owner,
 *   re-derives on every foreground, unsubscribes on unmount, does nothing
 *   for a null owner.
 * - `DaySecuredBanner` (59% covered at baseline): consumes the armed moment
 *   exactly once, renders the honest copy, auto-dismisses after HOLD_MS
 *   under reduced motion, renders nothing when no moment is pending.
 */
import React from 'react';
import { AppState, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

const mockHydrate = jest.fn(async () => {});
const mockRefresh = jest.fn(async () => {});
const mockConsumeDaySecured = jest.fn<unknown, []>(() => null);
const mockStoreState: {
  hydrate: typeof mockHydrate;
  refresh: typeof mockRefresh;
  consumeDaySecured: typeof mockConsumeDaySecured;
  daySecured: unknown;
} = {
  hydrate: mockHydrate,
  refresh: mockRefresh,
  consumeDaySecured: mockConsumeDaySecured,
  daySecured: null,
};
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (selector: (s: typeof mockStoreState) => unknown) =>
    selector(mockStoreState),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 20, left: 0, right: 0 }),
}));

const mockReducedMotion = { value: true };
jest.mock('../../src/design/components', () => {
  const actual = jest.requireActual<
    typeof import('../../src/design/components')
  >('../../src/design/components');
  return { ...actual, useReducedMotion: () => mockReducedMotion.value };
});

import { useConsistencyBootstrap } from '../../src/consistency/useConsistencyBootstrap';
import { DaySecuredBanner } from '../../src/consistency/DaySecuredBanner';

function Harness(props: { owner: string | null }) {
  useConsistencyBootstrap(props.owner);
  return null;
}

type AppStateHandler = (state: string) => void;

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

describe('audit: useConsistencyBootstrap', () => {
  let handlers: AppStateHandler[];
  let removeCalls: number;
  let addSpy: jest.SpyInstance;

  beforeEach(() => {
    handlers = [];
    removeCalls = 0;
    mockHydrate.mockClear();
    mockRefresh.mockClear();
    addSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_type, handler) => {
        handlers.push(handler as AppStateHandler);
        return {
          remove: () => {
            removeCalls += 1;
          },
        };
      });
  });

  afterEach(() => {
    addSpy.mockRestore();
  });

  it('does not hydrate for a null owner but still subscribes to foreground changes', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Harness owner={null} />);
    });
    expect(mockHydrate).not.toHaveBeenCalled();
    expect(handlers).toHaveLength(1);
    act(() => renderer.unmount());
    expect(removeCalls).toBe(1);
  });

  it('hydrates once per owner and again when the owner changes', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Harness owner="owner-a" />);
    });
    expect(mockHydrate).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.update(<Harness owner="owner-a" />);
    });
    expect(mockHydrate).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.update(<Harness owner="owner-b" />);
    });
    expect(mockHydrate).toHaveBeenCalledTimes(2);
    await act(async () => {
      renderer.update(<Harness owner={null} />);
    });
    expect(mockHydrate).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it('refreshes on every return to "active" and ignores background/inactive', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Harness owner="owner-a" />);
    });
    expect(handlers).toHaveLength(1);
    act(() => {
      handlers[0]!('background');
      handlers[0]!('inactive');
    });
    expect(mockRefresh).not.toHaveBeenCalled();
    act(() => {
      handlers[0]!('active');
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    act(() => {
      handlers[0]!('active');
    });
    expect(mockRefresh).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
    expect(removeCalls).toBe(1);
    // A late event after unmount must not be delivered through a live
    // subscription (the handler list here is the raw capture; the real
    // subscription was removed).
    expect(addSpy).toHaveBeenCalledTimes(1);
  });
});

describe('audit: DaySecuredBanner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockConsumeDaySecured.mockReset();
    mockConsumeDaySecured.mockReturnValue(null);
    mockStoreState.daySecured = null;
    mockReducedMotion.value = true;
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('renders nothing and consumes nothing when no moment is pending', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<DaySecuredBanner />);
    });
    expect(mockConsumeDaySecured).not.toHaveBeenCalled();
    expect(
      renderer.root.findAll(
        n =>
          typeof n.type === 'string' && n.props.testID === 'day-secured-banner',
      ),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('consumes the pending moment exactly once, shows honest copy, and auto-dismisses after the hold', () => {
    const moment = {
      day: '2026-09-04',
      streak: 18,
      xpToday: 35,
      shieldsAvailable: 1,
      nextMilestone: { title: '30 Day Club', daysAway: 12 },
    };
    mockStoreState.daySecured = moment;
    mockConsumeDaySecured.mockReturnValue(moment);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<DaySecuredBanner />);
    });
    expect(mockConsumeDaySecured).toHaveBeenCalledTimes(1);
    const banner = renderer.root.findAll(
      n =>
        typeof n.type === 'string' && n.props.testID === 'day-secured-banner',
    );
    expect(banner).toHaveLength(1);
    expect(banner[0]!.props.accessibilityLabel).toBe(
      'Day 18 secured. Plus 35 momentum XP. Next: 30 Day Club — 12 days away.',
    );
    const text = allText(renderer);
    expect(text).toContain('Day 18 secured');
    expect(text).toContain('+ 35 Momentum XP');
    expect(text).toContain('12 days away');

    // A re-render with the moment still "pending" in the store must not
    // consume again (the local `moment` state guards it).
    act(() => {
      renderer.update(<DaySecuredBanner />);
    });
    expect(mockConsumeDaySecured).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(3599);
    });
    expect(
      renderer.root.findAll(
        n =>
          typeof n.type === 'string' && n.props.testID === 'day-secured-banner',
      ),
    ).toHaveLength(1);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(
      renderer.root.findAll(
        n =>
          typeof n.type === 'string' && n.props.testID === 'day-secured-banner',
      ),
    ).toHaveLength(0);
    // Done: even a new pending moment is not consumed by this instance.
    mockStoreState.daySecured = { ...moment, day: '2026-09-05' };
    act(() => {
      renderer.update(<DaySecuredBanner />);
    });
    expect(mockConsumeDaySecured).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('omits the "Next" line when there is no next milestone and pluralizes a single day', () => {
    const moment = {
      day: '2026-09-04',
      streak: 1,
      xpToday: 10,
      shieldsAvailable: 0,
      nextMilestone: null,
    };
    mockStoreState.daySecured = moment;
    mockConsumeDaySecured.mockReturnValue(moment);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<DaySecuredBanner />);
    });
    const banner = renderer.root.findAll(
      n =>
        typeof n.type === 'string' && n.props.testID === 'day-secured-banner',
    );
    expect(banner[0]!.props.accessibilityLabel).toBe(
      'Day 1 secured. Plus 10 momentum XP.',
    );
    expect(allText(renderer)).not.toContain('Next:');
    act(() => renderer.unmount());

    const single = { ...moment, nextMilestone: { title: 'x', daysAway: 1 } };
    mockStoreState.daySecured = single;
    mockConsumeDaySecured.mockReturnValue(single);
    act(() => {
      renderer = TestRenderer.create(<DaySecuredBanner />);
    });
    expect(allText(renderer)).toContain('1 day away');
    expect(allText(renderer)).not.toContain('1 days away');
    act(() => renderer.unmount());
  });

  it('a pending flag whose consume returns null (already taken elsewhere) renders nothing', () => {
    mockStoreState.daySecured = { day: 'x' };
    mockConsumeDaySecured.mockReturnValue(null);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<DaySecuredBanner />);
    });
    expect(mockConsumeDaySecured).toHaveBeenCalledTimes(1);
    expect(
      renderer.root.findAll(
        n =>
          typeof n.type === 'string' && n.props.testID === 'day-secured-banner',
      ),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
