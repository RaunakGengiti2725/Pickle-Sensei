import React from 'react';
import {
  AppState,
  BackHandler,
  Modal,
  Platform,
  StyleSheet,
  type AppStateStatus,
} from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import TestRenderer, { act } from 'react-test-renderer';
import type { PlayerRankSummary } from '@pickle/shared-types';

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = jest.requireActual<typeof React>('react');
  const Native =
    jest.requireActual<typeof import('react-native')>('react-native');
  const passthrough = ({ children }: { children: React.ReactNode }) =>
    ReactActual.createElement(Native.View, null, children);
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    SafeAreaInsetsContext: ReactActual.createContext(null),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

const mockKv = new Map<string, string>();
const mockShots: Array<{
  id: string;
  sessionId: null;
  shotType: string;
  capturedAt: string;
  overallScore: number;
  resultKind: 'scored';
}> = [];
const mockWrite = jest.fn(async (key: string, value: string) => {
  mockKv.set(key, value);
});
const mockRead = jest.fn(async (key: string) => mockKv.get(key) ?? null);
const mockHydrate = jest.fn(async () => {});
const mockUnderlyingPress = jest.fn();
let mockOwner = '11111111-1111-4111-8111-111111111111';
const SECOND_OWNER = '22222222-2222-4222-8222-222222222222';
let mockSignedIn = true;
let mockReady = true;
let mockReducedMotion = false;

jest.mock('../src/data/db', () => ({ getDb: () => ({}) }));
jest.mock('../src/data/repository', () => ({
  getKv: (_db: unknown, key: string) => mockRead(key),
  setKv: (_db: unknown, key: string, value: string) => mockWrite(key, value),
  listActivityShots: async () => [...mockShots],
}));
jest.mock('../src/auth/authStore', () => ({
  useAuthStore: (select: (state: unknown) => unknown) =>
    select({
      hydrated: true,
      session: mockSignedIn
        ? { provider: 'google', canonicalAppUserId: mockOwner }
        : null,
      hydrate: mockHydrate,
      signOut: jest.fn(),
      busy: false,
    }),
}));
jest.mock('../src/state/appStore', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({
      hydrated: mockReady,
      ownerKey: mockSignedIn ? mockOwner : 'signed-out',
      profile: mockSignedIn ? { displayName: 'Player' } : null,
      hydrate: mockHydrate,
      hydrateError: null,
      awaitingApiSession: false,
    }),
}));
jest.mock('../src/account/sessionKeeper', () => ({
  refreshSessionNow: jest.fn(),
}));
jest.mock('../src/diagnostics/sentry', () => ({
  captureBoundaryError: jest.fn(),
  resetDiagnosticsScope: jest.fn(),
}));
jest.mock('../src/analysis/stabilityTelemetry', () => ({
  UNASSIGNED_STABILITY_USER_KEY: 'unassigned',
  stabilitySlo: { setContext: jest.fn(), record: jest.fn() },
}));
jest.mock('../src/notifications/useNotificationBootstrap', () => ({
  useNotificationBootstrap: () => {},
}));
jest.mock('../src/screens/OnboardingScreen', () => ({
  OnboardingScreen: () => null,
}));
jest.mock('../src/screens/WelcomeScreen', () => ({
  WelcomeScreen: () => null,
}));
jest.mock('../src/screens/SignInScreen', () => ({
  SignInScreen: () => null,
}));
jest.mock('../src/screens/SplashScreen', () => ({
  SplashScreen: ({ onFinished }: { onFinished: () => void }) => {
    const ReactActual = jest.requireActual<typeof React>('react');
    ReactActual.useEffect(onFinished, [onFinished]);
    return null;
  },
}));
jest.mock('../src/navigation/RootNavigator', () => ({
  RootNavigator: () => {
    const ReactActual = jest.requireActual<typeof React>('react');
    const Native =
      jest.requireActual<typeof import('react-native')>('react-native');
    return ReactActual.createElement(Native.Pressable, {
      testID: 'underlying-home-control',
      onPress: mockUnderlyingPress,
    });
  },
}));
jest.mock('../src/design/components', () => ({
  ...jest.requireActual('../src/design/components'),
  useReducedMotion: () => mockReducedMotion,
}));

import App from '../App';
import { CeremonyHost } from '../src/flow/CeremonyHost';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import { useRankCelebrationStore } from '../src/progress/rankCelebration';
import { useConsistencyStore } from '../src/consistency/store';
import {
  useWalkthroughStore,
  WALKTHROUGH_SEEN_VALUE,
  walkthroughKeyForOwner,
} from '../src/walkthrough/walkthroughStore';
import { registerWalkthroughMeasurer } from '../src/walkthrough/targets';

const summary: PlayerRankSummary = {
  rating: 5.5,
  tier: 'gold',
  tierLabel: 'Gold',
  division: 2,
  divisionLabel: 'II',
  techniqueCount: 1,
  scoredAnalysisCount: 3,
  techniques: [],
  nextTier: null,
};
const promoted: PlayerRankSummary = {
  ...summary,
  tier: 'diamond',
  tierLabel: 'Diamond',
  rating: 8,
};

let renderer: TestRenderer.ReactTestRenderer | undefined;
let unregister: Array<() => void>;
let appStateChange: Set<(state: AppStateStatus) => void>;
let backHandlers: Set<Parameters<typeof BackHandler.addEventListener>[1]>;

function overlays() {
  expect(
    renderer!.root.findByType(CeremonyHost).findAllByType(Modal),
  ).toHaveLength(0);
  return renderer!.root.findAll(
    node =>
      typeof node.type === 'string' && node.props.testID === 'ceremony-overlay',
  );
}

function stageIds() {
  return renderer!.root
    .findAll(
      node =>
        typeof node.type === 'string' &&
        [
          'rank-up-celebration',
          'streak-celebration',
          'first-run-walkthrough',
        ].includes(node.props.testID),
    )
    .map(node => node.props.testID);
}

function text() {
  return JSON.stringify(renderer!.toJSON());
}

async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });
}

function control(testID: string) {
  const target = renderer!.root.findAll(
    node => node.props.testID === testID && node.props.onPress,
  )[0]!;
  expect(target).toBeDefined();
  return target;
}

async function press(testID: string) {
  const target = control(testID);
  await act(async () => target.props.onPress());
}

type Kind = 'rank' | 'streak' | 'walkthrough';
const stageFor: Record<Kind, string> = {
  rank: 'rank-up-celebration',
  streak: 'streak-celebration',
  walkthrough: 'first-run-walkthrough',
};
const continueFor: Record<Kind, string> = {
  rank: 'rank-up-continue',
  streak: 'streak-celebration-continue',
  walkthrough: 'walkthrough-skip',
};

async function raise(kind: Kind) {
  await act(async () => {
    if (kind === 'rank') {
      await useRankCelebrationStore.getState().maybeCelebrate(summary);
    } else if (kind === 'streak') {
      seedDays(3);
      await useConsistencyStore.getState().refresh();
    } else {
      useWalkthroughStore.getState().replay();
    }
  });
}

async function finish(kind: Kind) {
  expect(overlays()).toHaveLength(1);
  expect(stageIds()).toEqual([stageFor[kind]]);
  await press(continueFor[kind]);
  expect(overlays().length).toBeLessThanOrEqual(1);
}

async function changeAppState(state: AppStateStatus) {
  AppState.currentState = state;
  await act(async () => appStateChange.forEach(fn => fn(state)));
}

async function changeOwner(owner: string, signedIn = true) {
  mockOwner = owner;
  mockSignedIn = signedIn;
  setActiveDataOwner(signedIn ? owner : SIGNED_OUT_DATA_OWNER);
  await act(async () => renderer!.update(<App />));
}

function seedDays(days: number) {
  mockShots.length = 0;
  for (let daysAgo = 0; daysAgo < days; daysAgo++) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - daysAgo);
    mockShots.push({
      id: `shot-${daysAgo}`,
      capturedAt: date.toISOString(),
      sessionId: null,
      shotType: 'dink',
      overallScore: 5.5,
      resultKind: 'scored',
    });
  }
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-09-06T22:00:00Z') });
  mockOwner = '11111111-1111-4111-8111-111111111111';
  mockSignedIn = true;
  mockReady = true;
  mockReducedMotion = false;
  mockKv.clear();
  // Every account these scenarios sign in as has already toured: the
  // walkthrough is owner-scoped, so an unseeded second account would raise
  // its own first-run tour on top of the ceremony under test.
  for (const owner of [mockOwner, SECOND_OWNER]) {
    mockKv.set(walkthroughKeyForOwner(owner), WALKTHROUGH_SEEN_VALUE);
  }
  mockShots.length = 0;
  mockUnderlyingPress.mockClear();
  mockRead.mockClear();
  mockWrite.mockClear();
  setActiveDataOwner(mockOwner);
  useRankCelebrationStore.setState({
    current: null,
    pending: null,
    queued: [],
  });
  useConsistencyStore.setState({
    ownerKey: null,
    hydrated: false,
    loadError: false,
    celebration: null,
    queuedCelebrations: [],
    snapshot: null,
    daySecured: null,
  });
  useWalkthroughStore.setState({
    visible: false,
    queued: false,
    request: null,
  });
  unregister = [
    'coach-fab',
    'rank-banner',
    'home-streak',
    'tab-library',
    'tab-progress',
  ].map(key =>
    registerWalkthroughMeasurer(
      key as Parameters<typeof registerWalkthroughMeasurer>[0],
      async () => ({ x: 20, y: 300, width: 200, height: 48 }),
    ),
  );
  appStateChange = new Set();
  backHandlers = new Set();
  AppState.currentState = 'active';
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, fn) => {
    appStateChange.add(fn);
    return { remove: () => appStateChange.delete(fn) };
  });
  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((_event, fn) => {
      backHandlers.add(fn);
      return { remove: () => backHandlers.delete(fn) };
    });
});

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  expect(backHandlers.size).toBe(0);
  expect(appStateChange.size).toBe(0);
  unregister.forEach(fn => fn());
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('App ceremony overlay arbitration without UIKit presentation callbacks', () => {
  it.each<Kind[]>([
    ['rank', 'streak', 'walkthrough'],
    ['rank', 'walkthrough', 'streak'],
    ['streak', 'rank', 'walkthrough'],
    ['streak', 'walkthrough', 'rank'],
    ['walkthrough', 'rank', 'streak'],
    ['walkthrough', 'streak', 'rank'],
  ])(
    'preserves arrival order %s → %s → %s with one mounted overlay',
    async (...order) => {
      await mount();
      for (const kind of order) {
        await raise(kind);
        expect(overlays()).toHaveLength(1);
        expect(stageIds()).toEqual([stageFor[order[0]!]]);
      }
      for (const kind of order) await finish(kind);
      expect(overlays()).toHaveLength(0);
      expect(useRankCelebrationStore.getState().queued).toEqual([]);
      expect(useConsistencyStore.getState().queuedCelebrations).toEqual([]);
      expect(useWalkthroughStore.getState().visible).toBe(false);
      expect(useWalkthroughStore.getState().queued).toBe(false);
    },
  );

  it.each([false, true])(
    'serializes all three in one commit with reduced motion %s',
    async reduced => {
      mockReducedMotion = reduced;
      await mount();
      seedDays(3);
      await act(async () => {
        await Promise.all([
          useConsistencyStore.getState().refresh(),
          useRankCelebrationStore.getState().maybeCelebrate(summary),
          Promise.resolve(useWalkthroughStore.getState().replay()),
        ]);
      });
      const seen: Kind[] = [];
      for (let index = 0; index < 3; index++) {
        expect(overlays()).toHaveLength(1);
        const kind = (Object.keys(stageFor) as Kind[]).find(
          candidate => stageFor[candidate] === stageIds()[0],
        )!;
        expect(kind).toBeDefined();
        if (reduced && kind === 'rank') expect(text()).toContain('5.50');
        seen.push(kind);
        await finish(kind);
      }
      expect(seen.sort()).toEqual(['rank', 'streak', 'walkthrough']);
      expect(overlays()).toHaveLength(0);
    },
  );

  it('recovers interaction when neither onShow nor onDismiss ever arrives', async () => {
    await mount();
    await raise('rank');
    await raise('walkthrough');
    const close = overlays()[0]!.props.onAccessibilityEscape;
    expect(overlays()[0]!.props.onShow).toBeUndefined();
    expect(overlays()[0]!.props.onDismiss).toBeUndefined();
    await act(async () => {
      close();
      close();
    });
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(stageIds()).toEqual(['first-run-walkthrough']);
    await finish('walkthrough');
    expect(overlays()).toHaveLength(0);
    expect(stageIds()).toEqual([]);
    await press('underlying-home-control');
    expect(mockUnderlyingPress).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(60_000));
    expect(overlays()).toHaveLength(0);
  });

  it('rerenders, refreshes and stale dismiss handlers cannot clear a successor', async () => {
    await mount();
    await raise('streak');
    await raise('rank');
    const close = overlays()[0]!.props.onAccessibilityEscape;
    await act(async () => {
      close();
      close();
      renderer!.update(<App />);
      await useConsistencyStore.getState().refresh();
      await useRankCelebrationStore.getState().maybeCelebrate(summary);
    });
    expect(stageIds()).toEqual(['rank-up-celebration']);
    const rank = useRankCelebrationStore.getState().current;
    await act(async () => {
      close();
      renderer!.update(<App />);
    });
    expect(overlays()).toHaveLength(1);
    expect(useRankCelebrationStore.getState().current).toBe(rank);
    await finish('rank');
    expect(overlays()).toHaveLength(0);
  });

  it('keeps separately earned ranks behind a streak, including the first placement', async () => {
    await mount();
    await raise('streak');
    await raise('rank');
    await act(async () => {
      await useRankCelebrationStore.getState().maybeCelebrate(promoted);
    });
    expect(useRankCelebrationStore.getState().queued).toHaveLength(1);
    await finish('streak');
    expect(text()).toContain('You’re on the board.');
    await finish('rank');
    expect(text()).toContain('Diamond unlocked');
    await finish('rank');
    expect(overlays()).toHaveLength(0);
  });

  it('keeps separately earned streaks behind a rank without losing either durable request', async () => {
    await mount();
    await raise('rank');
    seedDays(1);
    await act(async () => useConsistencyStore.getState().refresh());
    const first = useConsistencyStore.getState().celebration;
    expect(first?.achievementId).toBe('streak.1');
    await raise('streak');
    expect(useConsistencyStore.getState().celebration).toBe(first);
    expect(useConsistencyStore.getState().queuedCelebrations).toMatchObject([
      { achievementId: 'streak.3' },
    ]);
    await finish('rank');
    expect(text()).toContain('1 day of real training');
    await finish('streak');
    expect(text()).toContain('3 days of real training');
    await finish('streak');
    await act(async () => useConsistencyStore.getState().refresh());
    expect(overlays()).toHaveLength(0);
    expect(useConsistencyStore.getState().queuedCelebrations).toEqual([]);
  });

  it('background keeps an open ceremony and delays its successor until foreground', async () => {
    await mount();
    await raise('streak');
    await raise('rank');
    await changeAppState('background');
    expect(stageIds()).toEqual(['streak-celebration']);
    await finish('streak');
    expect(overlays()).toHaveLength(0);
    expect(useRankCelebrationStore.getState().current).not.toBeNull();
    await changeAppState('active');
    await finish('rank');
    expect(overlays()).toHaveLength(0);
  });

  it('queues earned ceremonies while the app starts in the background', async () => {
    AppState.currentState = 'background';
    seedDays(3);
    await mount();
    await raise('rank');
    expect(overlays()).toHaveLength(0);
    await changeAppState('active');
    await finish('streak');
    await finish('rank');
    expect(overlays()).toHaveLength(0);
  });

  it('disabling presentation removes content immediately and retains the request for retry', async () => {
    await mount();
    await raise('rank');
    const rank = useRankCelebrationStore.getState().current;
    const close = overlays()[0]!.props.onAccessibilityEscape;
    mockReady = false;
    await act(async () => renderer!.update(<App />));
    expect(overlays()).toHaveLength(0);
    expect(stageIds()).toEqual([]);
    expect(backHandlers.size).toBe(0);
    await act(async () => close());
    expect(useRankCelebrationStore.getState().current).toBe(rank);
    mockReady = true;
    await act(async () => renderer!.update(<App />));
    await act(async () => close());
    expect(stageIds()).toEqual(['rank-up-celebration']);
    await finish('rank');
  });

  it('owner A → B → A never leaks old content and retains requests without any native callbacks', async () => {
    const ownerA = mockOwner;
    const ownerB = SECOND_OWNER;
    await mount();
    await raise('streak');
    await raise('rank');
    const firstClose = overlays()[0]!.props.onAccessibilityEscape;
    mockShots.length = 0;
    await changeOwner(ownerB);
    expect(overlays()).toHaveLength(0);
    expect(stageIds()).toEqual([]);
    expect(text()).not.toContain('Kindling');
    await press('underlying-home-control');
    await act(async () => {
      await useRankCelebrationStore.getState().maybeCelebrate(promoted);
      firstClose();
    });
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(text()).toContain('Diamond');
    expect(text()).not.toContain('Kindling');
    const bClose = overlays()[0]!.props.onAccessibilityEscape;
    await changeOwner(ownerA);
    expect(stageIds()).toEqual(['streak-celebration']);
    expect(text()).not.toContain('Diamond');
    await act(async () => {
      firstClose();
      bClose();
    });
    expect(stageIds()).toEqual(['streak-celebration']);
    await finish('streak');
    await finish('rank');
    expect(overlays()).toHaveLength(0);
    await changeOwner(ownerB);
    await finish('rank');
    expect(overlays()).toHaveLength(0);
    expect(mockUnderlyingPress).toHaveBeenCalledTimes(1);
  });

  it('does not display old content while the active data owner and Gate props disagree', async () => {
    await mount();
    await raise('streak');
    const close = overlays()[0]!.props.onAccessibilityEscape;
    await act(async () => {
      setActiveDataOwner(SECOND_OWNER);
      close();
      renderer!.update(<App />);
    });
    expect(overlays()).toHaveLength(0);
    expect(stageIds()).toEqual([]);
    expect(useConsistencyStore.getState().celebration).not.toBeNull();
  });

  it('a same-owner ABA generation change invalidates old dismissal handlers', async () => {
    await mount();
    await raise('rank');
    const close = overlays()[0]!.props.onAccessibilityEscape;
    await act(async () => {
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      setActiveDataOwner(mockOwner);
      close();
      renderer!.update(<App />);
    });
    expect(stageIds()).toEqual(['rank-up-celebration']);
    await act(async () => close());
    expect(useRankCelebrationStore.getState().current).not.toBeNull();
    await finish('rank');
  });

  it('sign-out removes the view without consuming the earned streak and sign-in resumes it', async () => {
    const owner = mockOwner;
    await mount();
    await raise('streak');
    const close = overlays()[0]!.props.onAccessibilityEscape;
    await changeOwner(owner, false);
    expect(overlays()).toHaveLength(0);
    expect(stageIds()).toEqual([]);
    await act(async () => close());
    await changeOwner(owner);
    await finish('streak');
    expect(overlays()).toHaveLength(0);
  });

  it('an externally withdrawn request releases its view and presents the next request', async () => {
    await mount();
    await raise('walkthrough');
    await raise('rank');
    const close = overlays()[0]!.props.onAccessibilityEscape;
    await act(async () => useWalkthroughStore.getState().dismiss());
    expect(stageIds()).toEqual(['rank-up-celebration']);
    await act(async () => close());
    await finish('rank');
    expect(overlays()).toHaveLength(0);
  });

  it('unmount releases all handlers but does not consume a request that can be remounted', async () => {
    await mount();
    await raise('rank');
    const close = overlays()[0]!.props.onAccessibilityEscape;
    await act(async () => renderer!.unmount());
    expect(backHandlers.size).toBe(0);
    expect(appStateChange.size).toBe(0);
    await act(async () => close());
    expect(useRankCelebrationStore.getState().current).not.toBeNull();
    await mount();
    await act(async () => close());
    await finish('rank');
    expect(overlays()).toHaveLength(0);
  });

  it('failed milestone persistence does not mount a blocker or consume the retry', async () => {
    mockWrite.mockRejectedValueOnce(new Error('disk full'));
    seedDays(3);
    await mount();
    expect(overlays()).toHaveLength(0);
    await raise('rank');
    await finish('rank');
    await act(async () => useConsistencyStore.getState().refresh());
    await finish('streak');
    expect(overlays()).toHaveLength(0);
  });

  it('preserves the current tour step across queued arrivals, refreshes and a reduced-motion change', async () => {
    await mount();
    await raise('walkthrough');
    await press('walkthrough-advance');
    expect(text()).toContain('Only clear reads count.');
    await raise('rank');
    await raise('streak');
    mockReducedMotion = true;
    await act(async () => {
      renderer!.update(<App />);
      await useConsistencyStore.getState().refresh();
    });
    expect(stageIds()).toEqual(['first-run-walkthrough']);
    expect(text()).toContain('Only clear reads count.');
    expect(text()).not.toContain('Every read starts here.');
    await press('walkthrough-advance');
    expect(text()).toContain('Your reads live here.');
    await finish('walkthrough');
    await finish('rank');
    await finish('streak');
    expect(overlays()).toHaveLength(0);
  });

  it('a walkthrough whose measurement never completes paints a visible Skip that removes the overlay', async () => {
    unregister.forEach(fn => fn());
    unregister = [
      registerWalkthroughMeasurer('coach-fab', () => new Promise(() => {})),
    ];
    await mount();
    await raise('walkthrough');
    expect(text()).toContain('Finding this part of the app');
    expect(text()).toContain('walkthrough-measuring');
    await finish('walkthrough');
    expect(overlays()).toHaveLength(0);
    await press('underlying-home-control');
    expect(mockUnderlyingPress).toHaveBeenCalledTimes(1);
  });

  it('three scored days and first rank placement drain to the underlying controls', async () => {
    seedDays(3);
    await mount();
    expect(useConsistencyStore.getState().snapshot?.currentStreak).toBe(3);
    await raise('rank');
    expect(stageIds()).toEqual(['streak-celebration']);
    await finish('streak');
    expect(text()).toContain('You’re on the board.');
    await finish('rank');
    expect(overlays()).toHaveLength(0);
    await press('underlying-home-control');
    expect(mockUnderlyingPress).toHaveBeenCalledTimes(1);
  });

  it('configures the iOS window overlay with full-window bounds and accessibility modality', async () => {
    await mount();
    await raise('rank');
    const windowOverlay = renderer!.root.findByType(FullWindowOverlay);
    expect(windowOverlay.props.unstable_accessibilityContainerViewIsModal).toBe(
      true,
    );
    const overlay = overlays()[0]!;
    expect(overlay.props.accessibilityViewIsModal).toBe(true);
    expect(overlay.props.collapsable).toBe(false);
    expect(StyleSheet.flatten(overlay.props.style)).toMatchObject({
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
    await act(async () => overlay.props.onAccessibilityEscape());
    expect(renderer!.root.findAllByType(FullWindowOverlay)).toHaveLength(0);
    expect(overlays()).toHaveLength(0);
  });

  it('Android uses the root bounds and hardware back dismisses only the current request', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await mount();
    await raise('rank');
    await raise('walkthrough');
    expect(renderer!.root.findAllByType(FullWindowOverlay)).toHaveLength(0);
    expect(overlays()).toHaveLength(1);
    expect(backHandlers.size).toBe(1);
    const close = [...backHandlers][0]!;
    const event = { type: 'hardwareBackPress', timeStamp: Date.now() };
    await act(async () => expect(close(event)).toBe(true));
    expect(stageIds()).toEqual(['first-run-walkthrough']);
    await act(async () => expect(close(event)).toBe(false));
    expect(backHandlers.size).toBe(1);
    const nextClose = [...backHandlers][0]!;
    await act(async () => expect(nextClose(event)).toBe(true));
    expect(overlays()).toHaveLength(0);
    expect(backHandlers.size).toBe(0);
    await press('underlying-home-control');
    expect(mockUnderlyingPress).toHaveBeenCalledTimes(1);
  });
});
