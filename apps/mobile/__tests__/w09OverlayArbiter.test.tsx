/**
 * W09-04 — overlay/ceremony arbiter.
 *
 * The rank-up, streak and walkthrough ceremonies already serialise through
 * CeremonyHost; this suite pins the rest of the objective: the product's
 * other modal surfaces (error notices, the paywall, the system permission
 * sheet) share the same arbiter so exactly one surface is on screen at a
 * time, VoiceOver focus returns to the control that opened a surface once
 * it is gone, and a presented ceremony announces itself exactly once.
 */
import React from 'react';
import {
  AccessibilityInfo,
  AppState,
  LayoutChangeEvent,
  Modal,
  View,
} from 'react-native';
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
    initialWindowMetrics: null,
  };
});
jest.mock('react-native-linear-gradient', () => {
  const ReactActual = jest.requireActual<typeof React>('react');
  const Native =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Gradient = ({ children }: { children?: React.ReactNode }) =>
    ReactActual.createElement(Native.View, null, children);
  return { __esModule: true, default: Gradient };
});

/** react-test-renderer host refs resolve to node mocks; `findNodeHandle`
 * maps a node mock to its tag so focus restoration is observable. */
interface NodeMock {
  tag: number;
  label: string | undefined;
  measureInWindow: () => void;
  measure: () => void;
  setNativeProps: () => void;
}
const nodeTags = new Map<number, string | undefined>();
let nextTag = 0;
function mockIsNodeHandle(value: unknown): value is NodeMock {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tag' in value &&
    typeof (value as { tag: unknown }).tag === 'number'
  );
}
function createNodeMock(element: React.ReactElement): NodeMock {
  const tag = ++nextTag;
  const label = (element.props as { accessibilityLabel?: string })
    .accessibilityLabel;
  nodeTags.set(tag, label);
  return {
    tag,
    label,
    measureInWindow: () => {},
    measure: () => {},
    setNativeProps: () => {},
  };
}
jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => {
  const actual = jest.requireActual<
    typeof import('react-native/Libraries/ReactNative/RendererProxy')
  >('react-native/Libraries/ReactNative/RendererProxy');
  return {
    ...actual,
    findNodeHandle: (instance: unknown) =>
      mockIsNodeHandle(instance)
        ? instance.tag
        : actual.findNodeHandle(
            instance as Parameters<typeof actual.findNodeHandle>[0],
          ),
  };
});

const mockKv = new Map<string, string>();
jest.mock('../src/data/db', () => ({ getDb: () => ({}) }));
jest.mock('../src/data/repository', () => ({
  getKv: async (_db: unknown, key: string) => mockKv.get(key) ?? null,
  setKv: async (_db: unknown, key: string, value: string) => {
    mockKv.set(key, value);
  },
  listActivityShots: async () => [],
}));
jest.mock('../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
  useFocusEffect: () => undefined,
}));
jest.mock('../src/review/appStoreReview', () => ({
  rateAppFromSettings: async () => 'requested',
}));
jest.mock('../src/config/runtimeConfig', () => {
  const actual = jest.requireActual<
    typeof import('../src/config/runtimeConfig')
  >('../src/config/runtimeConfig');
  return {
    getRuntimePublicConfig: () => ({
      ...actual.getRuntimePublicConfig(),
      appVersion: '9.9.9-test',
      legalPrivacyUrl: null,
      legalTermsUrl: null,
    }),
  };
});

import { CeremonyHost } from '../src/flow/CeremonyHost';
import { RankUpCelebration } from '../src/components/RankUpCelebration';
import { StreakCelebration } from '../src/consistency/StreakCelebration';
import {
  FirstRunWalkthrough,
  WALKTHROUGH_STEPS,
} from '../src/walkthrough/FirstRunWalkthrough';
import { BrandNoticeHost, showBrandNotice } from '../src/design/BrandNotice';
import { BrandDialog } from '../src/design/components';
import { PaywallScreen } from '../src/screens/PaywallScreen';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';
import { useRankCelebrationStore } from '../src/progress/rankCelebration';
import { useConsistencyStore } from '../src/consistency/store';
import {
  useWalkthroughStore,
  WALKTHROUGH_KV_KEY,
  WALKTHROUGH_SEEN_VALUE,
} from '../src/walkthrough/walkthroughStore';
import { registerWalkthroughMeasurer } from '../src/walkthrough/targets';
import { useNotificationStore } from '../src/notifications/notificationStore';
import type {
  PermissionState,
  SchedulerPort,
} from '../src/notifications/service';
import { useAuthStore, type AuthSession } from '../src/auth/authStore';
import { useAppStore } from '../src/state/appStore';
import { useConsentStore } from '../src/state/consentStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../src/notifications/types';
import { useAccessStore } from '../src/state/accessStore';

const OWNER = '11111111-1111-4111-8111-111111111111';
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
const RANK_ANNOUNCEMENT = 'You are on the board: Gold. Rating 5.50 out of 10.';

let renderer: TestRenderer.ReactTestRenderer | undefined;
let unregister: Array<() => void>;
let announce: jest.SpyInstance;
let setFocus: jest.SpyInstance;

/** The shipping composition (App.tsx): the global ceremony host with its
 * three stages beside the product-owned notice host. */
function Shell(props: { paywall?: boolean; onClosePaywall?: () => void }) {
  return (
    <>
      <CeremonyHost ownerKey={OWNER}>
        <RankUpCelebration />
        <StreakCelebration />
        <FirstRunWalkthrough />
      </CeremonyHost>
      <BrandNoticeHost />
      {props.paywall ? (
        <PaywallScreen onClose={props.onClosePaywall ?? (() => {})} />
      ) : null}
    </>
  );
}

async function mount(element: React.ReactElement, withNodeMocks = false) {
  await act(async () => {
    renderer = TestRenderer.create(
      element,
      withNodeMocks ? { createNodeMock } : undefined,
    );
  });
}

async function update(element: React.ReactElement) {
  await act(async () => renderer!.update(element));
}

function overlays() {
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

function noticeVisible(): boolean {
  const host = renderer!.root.findByType(BrandNoticeHost);
  return host.findByType(Modal).props.visible === true;
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

async function raiseRank() {
  await act(async () => {
    await useRankCelebrationStore.getState().maybeCelebrate(summary);
  });
}

async function raiseWalkthrough() {
  await act(async () => {
    useWalkthroughStore.getState().replay();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function scheduler(
  requestPermission: () => Promise<PermissionState>,
): SchedulerPort {
  return {
    permissionState: async () => 'denied',
    requestPermission,
    applyPlan: async () => {},
    cancelAllPlanned: async () => {},
    openSystemSettings: async () => {},
  };
}

const syncedSession: AuthSession = {
  provider: 'google',
  subject: OWNER,
  canonicalAppUserId: OWNER,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

function seedSettingsStores() {
  useAuthStore.setState({
    hydrated: true,
    session: syncedSession,
    busy: false,
    error: null,
    signOut: jest.fn(() => Promise.resolve()),
  });
  useAppStore.setState({
    hydrated: true,
    profile: {
      firstName: 'Alex',
      gender: 'female',
      skillLevel: 'intermediate',
      handedness: 'right',
      focusCheckpoint: 'contact_point',
    } as never,
  });
  useConsentStore.setState({
    availability: 'ready',
    modelTrainingActive: false,
    busy: false,
    error: null,
    hydrate: jest.fn(() => Promise.resolve()),
  });
  useNotificationStore.setState({
    prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
    permission: 'granted',
  });
  useConsistencyStore.setState({ snapshot: null });
  useAccessStore.setState({ canonicalAccess: null });
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-09-06T22:00:00Z') });
  mockKv.clear();
  mockKv.set(WALKTHROUGH_KV_KEY, WALKTHROUGH_SEEN_VALUE);
  nodeTags.clear();
  nextTag = 0;
  mockNavigate.mockClear();
  setActiveDataOwner(OWNER);
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
  useNotificationStore.setState({ permission: 'unknown' });
  AppState.currentState = 'active';
  unregister = ['coach-fab', 'rank-banner', 'tab-library', 'tab-progress'].map(
    key =>
      registerWalkthroughMeasurer(
        key as Parameters<typeof registerWalkthroughMeasurer>[0],
        async () => ({ x: 20, y: 300, width: 200, height: 48 }),
      ),
  );
  announce = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibility')
    .mockImplementation(() => {});
  setFocus = jest
    .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
    .mockImplementation(() => {});
  announce.mockClear();
  setFocus.mockClear();
});

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  unregister.forEach(fn => fn());
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('one modal surface at a time', () => {
  it('holds an error notice raised over a showing rank-up until the ceremony is dismissed', async () => {
    await mount(<Shell />);
    await raiseRank();
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);

    await act(async () =>
      showBrandNotice({
        title: 'Privacy policy could not be opened',
        detail: 'Your phone could not open the page.',
        tone: 'danger',
      }),
    );
    expect(overlays()).toHaveLength(1);
    expect(noticeVisible()).toBe(false);

    await press('rank-up-continue');
    expect(overlays()).toHaveLength(0);
    expect(noticeVisible()).toBe(true);
    expect(useRankCelebrationStore.getState().current).toBeNull();
  });

  it('holds a rank-up raised behind a showing error notice until the notice is dismissed', async () => {
    await mount(<Shell />);
    await act(async () =>
      showBrandNotice({
        title: 'Rating unavailable right now',
        detail: 'The App Store rating sheet could not be opened.',
      }),
    );
    expect(noticeVisible()).toBe(true);

    await raiseRank();
    expect(useRankCelebrationStore.getState().current).not.toBeNull();
    expect(overlays()).toHaveLength(0);
    expect(noticeVisible()).toBe(true);

    const dialog = renderer!.root.findByType(BrandDialog);
    await act(async () => dialog.props.onDismiss());
    expect(noticeVisible()).toBe(false);
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
  });

  it('withdraws the ceremony while the system notification permission sheet is up and re-presents it afterwards', async () => {
    await mount(<Shell />);
    const prompt = deferred<PermissionState>();
    let outcome: Promise<boolean> | undefined;
    await act(async () => {
      outcome = useNotificationStore.getState().requestPermissionAndEnable({
        scheduler: scheduler(() => prompt.promise),
      });
    });

    await raiseRank();
    expect(useRankCelebrationStore.getState().current).not.toBeNull();
    expect(overlays()).toHaveLength(0);

    await act(async () => {
      prompt.resolve('denied');
      await outcome;
    });
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(useRankCelebrationStore.getState().current).not.toBeNull();
  });

  it('withdraws a showing ceremony while the paywall is on screen and re-presents it when the paywall closes', async () => {
    await mount(<Shell />);
    await raiseRank();
    expect(overlays()).toHaveLength(1);

    await update(<Shell paywall />);
    expect(overlays()).toHaveLength(0);
    expect(useRankCelebrationStore.getState().current).not.toBeNull();

    await update(<Shell />);
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
  });

  it('a notice raised during the paywall waits for the paywall, then the held ceremony follows the notice', async () => {
    await mount(<Shell paywall />);
    await raiseRank();
    await act(async () =>
      showBrandNotice({
        title: 'Terms of use could not be opened',
        detail: '',
      }),
    );
    expect(overlays()).toHaveLength(0);
    expect(noticeVisible()).toBe(false);

    await update(<Shell />);
    expect(overlays()).toHaveLength(0);
    expect(noticeVisible()).toBe(true);

    const dialog = renderer!.root.findByType(BrandDialog);
    await act(async () => dialog.props.onDismiss());
    expect(noticeVisible()).toBe(false);
    expect(overlays()).toHaveLength(1);
  });
});

describe('announcements', () => {
  it('announces a presented ceremony exactly once, even when the stage re-renders', async () => {
    await mount(<Shell />);
    await raiseRank();
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(RANK_ANNOUNCEMENT);

    await update(<Shell />);
    await update(<Shell />);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('announces a walkthrough step once even when the overlay re-measures after a layout change', async () => {
    await mount(<Shell />);
    await raiseWalkthrough();
    const stepOne = `Walkthrough, step 1 of ${WALKTHROUGH_STEPS.length}. ${
      WALKTHROUGH_STEPS[0]!.headline
    } ${WALKTHROUGH_STEPS[0]!.body}`;
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith(stepOne);

    const host = renderer!.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.testID === 'first-run-walkthrough',
    )[0]!;
    const relayout = {
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 780 } },
    } as LayoutChangeEvent;
    await act(async () => host.props.onLayout(relayout));
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(announce).toHaveBeenCalledTimes(1);

    await press('walkthrough-advance');
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith(
      expect.stringContaining(
        `Walkthrough, step 2 of ${WALKTHROUGH_STEPS.length}.`,
      ),
    );
  });

  it('re-announces a ceremony that returns after yielding to the paywall (a new presentation)', async () => {
    await mount(<Shell />);
    await raiseRank();
    expect(announce).toHaveBeenCalledTimes(1);
    await update(<Shell paywall />);
    await update(<Shell />);
    expect(overlays()).toHaveLength(1);
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith(RANK_ANNOUNCEMENT);
  });
});

describe('focus returns to the trigger', () => {
  function SettingsWithCeremonies() {
    return (
      <View>
        <SettingsScreen />
        <CeremonyHost ownerKey={OWNER}>
          <FirstRunWalkthrough />
        </CeremonyHost>
      </View>
    );
  }

  function replayRow() {
    return renderer!.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityLabel === 'App walkthrough, Replay' &&
        typeof node.props.onClick === 'function',
    )[0]!;
  }

  it('Settings → App walkthrough · Replay: dismissing the tour moves VoiceOver focus back to the row', async () => {
    seedSettingsStores();
    await mount(<SettingsWithCeremonies />, true);
    const row = replayRow();
    expect(row).toBeDefined();
    await act(async () => row.props.onClick());
    expect(mockNavigate).toHaveBeenCalledWith('Tabs', { screen: 'Home' });
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['first-run-walkthrough']);
    expect(setFocus).not.toHaveBeenCalled();

    await press('walkthrough-skip');
    expect(overlays()).toHaveLength(0);
    expect(setFocus).toHaveBeenCalledTimes(1);
    const [tag] = setFocus.mock.calls[0] as [number];
    expect(nodeTags.get(tag)).toBe('App walkthrough, Replay');
  });

  it('a ceremony without a trigger leaves VoiceOver focus alone on dismissal', async () => {
    await mount(<Shell />, true);
    await raiseRank();
    await press('rank-up-continue');
    expect(overlays()).toHaveLength(0);
    expect(setFocus).not.toHaveBeenCalled();
  });
});
