/**
 * W09-04 adversarial suite (attack branch devin/pp/w09-04/attack-e0c19d11).
 *
 * Attacks the overlay/ceremony arbiter at its failure boundaries: re-entrant
 * dismissal, double-submitted permission prompts, a rejected permission
 * request, ordering after a blocker withdraws every slot, an interleaved
 * account switch while a ceremony is withheld, tree teardown/remount with
 * a blocker in flight, duplicate replay triggers, walkthrough progress
 * across a preemption, and numeric trigger boundary values. Every test is
 * a real expectation about supported behaviour; a failing test here is a
 * confirmed break of the candidate.
 */
import React from 'react';
import {
  AccessibilityInfo,
  AppState,
  Modal,
  View,
  type AppStateStatus,
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

/** Same host-tag resolution as the candidate suite: React Native's real
 * `findNodeHandle` runs first (so an unmounted instance throws as on
 * device), then the mounted class-component instance is followed to the
 * host element it rendered and given one stable tag. */
interface Fiber {
  tag: number;
  child: Fiber | null;
  stateNode: unknown;
  memoizedProps: unknown;
}
const HOST_COMPONENT_FIBER = 5;
const nodeTags = new Map<number, string | undefined>();
const hostTags = new WeakMap<object, number>();
let nextTag = 0;
function mockHostTag(instance: unknown): number | null {
  if (typeof instance !== 'object' || instance === null) return null;
  let fiber = (instance as { _reactInternals?: Fiber })._reactInternals ?? null;
  while (fiber && fiber.tag !== HOST_COMPONENT_FIBER) fiber = fiber.child;
  if (
    !fiber ||
    typeof fiber.stateNode !== 'object' ||
    fiber.stateNode === null
  ) {
    return null;
  }
  let tag = hostTags.get(fiber.stateNode);
  if (tag === undefined) {
    tag = ++nextTag;
    hostTags.set(fiber.stateNode, tag);
    nodeTags.set(
      tag,
      (fiber.memoizedProps as { accessibilityLabel?: string })
        .accessibilityLabel,
    );
  }
  return tag;
}
jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => {
  const actual = jest.requireActual<{
    findNodeHandle: (instance: unknown) => number | null;
  }>('react-native/Libraries/ReactNative/RendererProxy');
  return {
    ...actual,
    findNodeHandle: (instance: unknown) =>
      actual.findNodeHandle(instance) ?? mockHostTag(instance),
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
import {
  claimSurface,
  presentedSurfaceId,
  restoreFocusToTrigger,
} from '../src/flow/ceremonyRequest';
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
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const gold: PlayerRankSummary = {
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
const platinum: PlayerRankSummary = {
  ...gold,
  rating: 6.75,
  tier: 'platinum',
  tierLabel: 'Platinum',
  scoredAnalysisCount: 4,
};
const GOLD_ANNOUNCEMENT = 'You are on the board: Gold. Rating 5.50 out of 10.';
const PLATINUM_ANNOUNCEMENT = 'Rank up: Platinum. Rating 6.75 out of 10.';
const stepAnnouncement = (index: number) =>
  `Walkthrough, step ${index + 1} of ${WALKTHROUGH_STEPS.length}. ${
    WALKTHROUGH_STEPS[index]!.headline
  } ${WALKTHROUGH_STEPS[index]!.body}`;

let renderer: TestRenderer.ReactTestRenderer | undefined;
let unregister: Array<() => void>;
let announce: jest.SpyInstance;
let setFocus: jest.SpyInstance;
let appStateChange: Set<(state: AppStateStatus) => void>;

/** App.tsx shape: one global ceremony host with its stages beside the
 * notice host; the paywall is a navigation route mounted over them; the
 * signed-in content (which owns the Settings row) can be swapped out. */
function Shell(props: {
  ownerKey?: string;
  paywall?: boolean;
  settings?: boolean;
}) {
  return (
    <View>
      {props.settings ? <SettingsScreen /> : null}
      <CeremonyHost ownerKey={props.ownerKey ?? OWNER}>
        <RankUpCelebration />
        <StreakCelebration />
        <FirstRunWalkthrough />
      </CeremonyHost>
      <BrandNoticeHost />
      {props.paywall ? <PaywallScreen onClose={() => {}} /> : null}
    </View>
  );
}

async function mount(element: React.ReactElement) {
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
}

async function update(element: React.ReactElement) {
  await act(async () => renderer!.update(element));
}

async function unmountTree() {
  await act(async () => renderer!.unmount());
  renderer = undefined;
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

const TEXT_HOST: string = 'Text';

function text(): string {
  return renderer!.root
    .findAll(node => typeof node.type === 'string' && node.type === TEXT_HOST)
    .flatMap(node => React.Children.toArray(node.props.children))
    .filter((child): child is string => typeof child === 'string')
    .join('\n');
}

function noticeVisible(): boolean {
  const host = renderer!.root.findByType(BrandNoticeHost);
  return host.findByType(Modal).props.visible === true;
}

async function dismissNotice() {
  const dialog = renderer!.root.findByType(BrandDialog);
  await act(async () => dialog.props.onDismiss());
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

async function raiseRank(summary: PlayerRankSummary = gold) {
  await act(async () => {
    await useRankCelebrationStore.getState().maybeCelebrate(summary);
  });
}

async function raiseWalkthrough() {
  await act(async () => {
    useWalkthroughStore.getState().replay();
  });
}

async function showNotice(title = 'Privacy policy could not be opened') {
  await act(async () =>
    showBrandNotice({
      title,
      detail: 'Your phone could not open the page.',
      tone: 'danger',
    }),
  );
}

async function changeAppState(state: AppStateStatus) {
  AppState.currentState = state;
  await act(async () => appStateChange.forEach(fn => fn(state)));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

/** Starts a system permission prompt; the returned `finish` settles it. */
async function openPermissionSheet() {
  const prompt = deferred<PermissionState>();
  let outcome: Promise<boolean> | undefined;
  await act(async () => {
    outcome = useNotificationStore.getState().requestPermissionAndEnable({
      scheduler: scheduler(() => prompt.promise),
    });
  });
  return {
    finish: async (state: PermissionState = 'denied') => {
      await act(async () => {
        prompt.resolve(state);
        await outcome;
      });
    },
    fail: async () => {
      await act(async () => {
        prompt.reject(new Error('notification module unavailable'));
        await outcome;
      });
    },
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

function replayRow() {
  return renderer!.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.accessibilityLabel === 'App walkthrough, Replay' &&
      typeof node.props.onClick === 'function',
  )[0]!;
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
  appStateChange = new Set();
  AppState.currentState = 'active';
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, fn) => {
    appStateChange.add(fn);
    return { remove: () => appStateChange.delete(fn) };
  });
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

describe('attack: concurrency / re-entrancy', () => {
  it('a double-tapped Continue plus VoiceOver escape in one tick dismisses only the showing rank-up; the queued rank-up is still presented and announced once', async () => {
    await mount(<Shell />);
    await raiseRank(gold);
    await raiseRank(platinum);
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(useRankCelebrationStore.getState().queued).toHaveLength(1);
    expect(announce).toHaveBeenCalledTimes(1);

    const button = control('rank-up-continue');
    const overlay = overlays()[0]!;
    await act(async () => {
      button.props.onPress();
      button.props.onPress();
      overlay.props.onAccessibilityEscape();
    });

    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(useRankCelebrationStore.getState().queued).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(text()).toContain('Platinum');
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith(PLATINUM_ANNOUNCEMENT);
    expect(setFocus).not.toHaveBeenCalled();

    await press('rank-up-continue');
    expect(overlays()).toHaveLength(0);
    expect(useRankCelebrationStore.getState().queued).toHaveLength(0);
  });

  it('two permission prompts in flight (double submit): the ceremony stays withdrawn until the LAST sheet settles and is then presented once', async () => {
    await mount(<Shell />);
    const first = await openPermissionSheet();
    const second = await openPermissionSheet();

    await raiseRank();
    expect(overlays()).toHaveLength(0);
    expect(announce).not.toHaveBeenCalled();

    await first.finish('granted');
    expect(overlays()).toHaveLength(0);
    expect(announce).not.toHaveBeenCalled();

    await second.finish('granted');
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith(GOLD_ANNOUNCEMENT);
  });

  it('Continue is tapped in the same tick the paywall route mounts: the first rank-up completes, the queued one is withheld and presented once after the paywall closes in original order', async () => {
    await mount(<Shell />);
    await raiseRank(gold);
    await raiseRank(platinum);
    expect(announce).toHaveBeenCalledTimes(1);

    const button = control('rank-up-continue');
    await act(async () => {
      button.props.onPress();
      renderer!.update(<Shell paywall />);
    });
    expect(overlays()).toHaveLength(0);
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(useRankCelebrationStore.getState().queued).toHaveLength(1);
    expect(announce).toHaveBeenCalledTimes(1);

    await update(<Shell />);
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(text()).toContain('Platinum');
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith(PLATINUM_ANNOUNCEMENT);
  });

  it('two rank-ups withheld together by the permission sheet return in their original order', async () => {
    await mount(<Shell />);
    const sheet = await openPermissionSheet();
    await raiseRank(gold);
    await raiseRank(platinum);
    expect(overlays()).toHaveLength(0);

    await sheet.finish('denied');
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(text()).toContain('5.50');
    expect(text()).not.toContain('Platinum');
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith(GOLD_ANNOUNCEMENT);

    await press('rank-up-continue');
    expect(text()).toContain('Platinum');
    expect(announce).toHaveBeenCalledTimes(2);
    await press('rank-up-continue');
    expect(overlays()).toHaveLength(0);
  });

  it('the permission sheet is up while the app goes inactive and comes back: the ceremony returns exactly once', async () => {
    await mount(<Shell />);
    await raiseRank();
    expect(overlays()).toHaveLength(1);
    expect(announce).toHaveBeenCalledTimes(1);

    const sheet = await openPermissionSheet();
    expect(overlays()).toHaveLength(0);
    await changeAppState('inactive');
    expect(overlays()).toHaveLength(0);

    await sheet.finish('granted');
    expect(overlays()).toHaveLength(0);
    await changeAppState('active');
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(announce).toHaveBeenCalledTimes(2);
    expect(useRankCelebrationStore.getState().current).not.toBeNull();
  });
});

describe('attack: permission request failure path', () => {
  it('the notification module rejects the permission request: the blocker is released and the withheld notice and ceremony both come back in priority order', async () => {
    await mount(<Shell />);
    await showNotice();
    expect(noticeVisible()).toBe(true);
    await raiseRank();
    expect(overlays()).toHaveLength(0);

    const sheet = await openPermissionSheet();
    expect(noticeVisible()).toBe(false);
    expect(overlays()).toHaveLength(0);

    await sheet.fail();
    expect(useNotificationStore.getState().permission).toBe('unknown');
    expect(noticeVisible()).toBe(true);
    expect(overlays()).toHaveLength(0);
    expect(announce).not.toHaveBeenCalled();

    await dismissNotice();
    expect(noticeVisible()).toBe(false);
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(announce).toHaveBeenCalledTimes(1);
  });
});

describe('attack: ordering after a dismissal with both a waiting notice and a queued ceremony', () => {
  it('dismissing the first rank-up shows the waiting notice; the queued rank-up waits behind it and announces exactly once when finally presented', async () => {
    await mount(<Shell />);
    await raiseRank(gold);
    await raiseRank(platinum);
    await showNotice();
    expect(noticeVisible()).toBe(false);
    expect(announce).toHaveBeenCalledTimes(1);

    await press('rank-up-continue');
    expect(overlays()).toHaveLength(0);
    expect(noticeVisible()).toBe(true);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(useRankCelebrationStore.getState().queued).toHaveLength(1);

    await dismissNotice();
    expect(noticeVisible()).toBe(false);
    expect(overlays()).toHaveLength(1);
    expect(text()).toContain('Platinum');
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith(PLATINUM_ANNOUNCEMENT);
  });

  it('a notice raised while the paywall withholds a ceremony is dismissed before the paywall closes: the ceremony returns once', async () => {
    await mount(<Shell paywall />);
    await raiseRank();
    await showNotice('Terms of use could not be opened');
    expect(noticeVisible()).toBe(true);
    expect(overlays()).toHaveLength(0);
    await dismissNotice();
    expect(overlays()).toHaveLength(0);
    expect(announce).not.toHaveBeenCalled();

    await update(<Shell />);
    expect(overlays()).toHaveLength(1);
    expect(announce).toHaveBeenCalledTimes(1);
  });
});

describe('attack: accessibility of the surface that wins', () => {
  it('the notice over the paywall is the only VoiceOver-modal surface; the withheld ceremony is out of the tree, not merely hidden', async () => {
    await mount(<Shell paywall />);
    await raiseRank();
    await showNotice('Terms of use could not be opened');
    expect(noticeVisible()).toBe(true);
    expect(overlays()).toHaveLength(0);
    expect(stageIds()).toEqual([]);

    const modalHosts = renderer!.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityViewIsModal === true,
    );
    expect(modalHosts).toHaveLength(1);
    expect(modalHosts[0]!.props.testID).toBe('brand-notice');
    expect(announce).not.toHaveBeenCalled();
  });

  it('a presented ceremony is announced once and its overlay is the modal VoiceOver container with an escape gesture that dismisses it', async () => {
    await mount(<Shell />);
    await raiseRank();
    const overlay = overlays()[0]!;
    expect(overlay.props.importantForAccessibility).toBe('yes');
    expect(overlay.props.accessibilityViewIsModal).toBe(true);
    expect(announce).toHaveBeenCalledTimes(1);
    await act(async () => overlay.props.onAccessibilityEscape());
    expect(overlays()).toHaveLength(0);
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(announce).toHaveBeenCalledTimes(1);
  });
});

describe('attack: interleaved account switch while a ceremony is withheld', () => {
  it("owner A's rank-up withheld by the paywall never presents for owner B; it returns for A only", async () => {
    await mount(<Shell />);
    await raiseRank();
    expect(overlays()).toHaveLength(1);
    const celebration = useRankCelebrationStore.getState().current;

    await update(<Shell paywall />);
    expect(overlays()).toHaveLength(0);

    setActiveDataOwner(OTHER_OWNER);
    await update(<Shell ownerKey={OTHER_OWNER} paywall />);
    await update(<Shell ownerKey={OTHER_OWNER} />);
    expect(overlays()).toHaveLength(0);
    expect(announce).toHaveBeenCalledTimes(1);

    await showNotice('Sync paused');
    expect(noticeVisible()).toBe(true);
    await dismissNotice();
    expect(overlays()).toHaveLength(0);

    setActiveDataOwner(OWNER);
    await update(<Shell />);
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(useRankCelebrationStore.getState().current).toBe(celebration);
  });

  it('signing out while the permission sheet withholds a rank-up: nothing presents for the signed-out owner and the sheet release leaves no dead blocker behind', async () => {
    await mount(<Shell />);
    await raiseRank();
    const sheet = await openPermissionSheet();
    expect(overlays()).toHaveLength(0);

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await update(<Shell ownerKey={SIGNED_OUT_DATA_OWNER} />);
    await sheet.finish('denied');
    expect(overlays()).toHaveLength(0);

    setActiveDataOwner(OWNER);
    await update(<Shell />);
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
  });
});

describe('attack: tree teardown and remount (process-death analogue for the module registry)', () => {
  it('the whole tree unmounts while a permission sheet is in flight and a rank-up waits; after remount the sheet settling presents the rank-up once', async () => {
    await mount(<Shell />);
    const sheet = await openPermissionSheet();
    await raiseRank();
    expect(overlays()).toHaveLength(0);

    await unmountTree();
    expect(presentedSurfaceId()).toBeNull();

    await mount(<Shell />);
    expect(overlays()).toHaveLength(0);
    await sheet.finish('granted');
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('unmounting the tree with the paywall, a presented notice and a withheld ceremony leaves no claim behind: a fresh slot claim is presented immediately', async () => {
    await mount(<Shell paywall />);
    await raiseRank();
    await showNotice();
    expect(noticeVisible()).toBe(true);
    expect(presentedSurfaceId()).not.toBeNull();

    await unmountTree();
    expect(presentedSurfaceId()).toBeNull();
    const probe = claimSurface('ceremony');
    expect(presentedSurfaceId()).toBe(probe.id);
    probe.release();
    expect(presentedSurfaceId()).toBeNull();

    await mount(<Shell />);
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
  });
});

describe('attack: replay / duplicate trigger identity', () => {
  it('Settings Replay tapped twice: one tour, focus returns to the row once, and a later rank-up dismissal does not inherit the stale trigger', async () => {
    seedSettingsStores();
    await mount(<Shell settings />);
    const row = replayRow();
    await act(async () => {
      row.props.onClick();
      row.props.onClick();
    });
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['first-run-walkthrough']);
    expect(announce).toHaveBeenCalledTimes(1);

    await press('walkthrough-skip');
    expect(overlays()).toHaveLength(0);
    expect(setFocus).toHaveBeenCalledTimes(1);
    const [tag] = setFocus.mock.calls[0] as [number];
    expect(nodeTags.get(tag)).toBe('App walkthrough, Replay');

    await raiseRank();
    expect(stageIds()).toEqual(['rank-up-celebration']);
    await press('rank-up-continue');
    expect(overlays()).toHaveLength(0);
    expect(setFocus).toHaveBeenCalledTimes(1);
  });

  it('Settings Replay while a rank-up is showing: the tour queues with its trigger and, once the rank-up is dismissed and the tour skipped, focus returns to the row', async () => {
    seedSettingsStores();
    await mount(<Shell settings />);
    await raiseRank();
    expect(stageIds()).toEqual(['rank-up-celebration']);

    await act(async () => replayRow().props.onClick());
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(useWalkthroughStore.getState().queued).toBe(true);

    await press('rank-up-continue');
    expect(stageIds()).toEqual(['first-run-walkthrough']);
    expect(setFocus).not.toHaveBeenCalled();

    await press('walkthrough-skip');
    expect(overlays()).toHaveLength(0);
    expect(setFocus).toHaveBeenCalledTimes(1);
    const [tag] = setFocus.mock.calls[0] as [number];
    expect(nodeTags.get(tag)).toBe('App walkthrough, Replay');
  });
});

describe('attack: walkthrough progress across a preemption', () => {
  it('the tour is on step 3 when the notification permission sheet preempts it: it resumes on step 3 and does not re-announce step 1', async () => {
    await mount(<Shell />);
    await raiseWalkthrough();
    await press('walkthrough-advance');
    await press('walkthrough-advance');
    expect(text()).toContain(WALKTHROUGH_STEPS[2]!.headline);
    expect(announce).toHaveBeenCalledTimes(3);

    const sheet = await openPermissionSheet();
    expect(overlays()).toHaveLength(0);
    await sheet.finish('granted');
    expect(stageIds()).toEqual(['first-run-walkthrough']);
    expect(text()).toContain(WALKTHROUGH_STEPS[2]!.headline);
    expect(text()).not.toContain(WALKTHROUGH_STEPS[0]!.headline);
    expect(announce).not.toHaveBeenLastCalledWith(stepAnnouncement(0));
  });

  it('the tour is on step 3 when the paywall preempts it: it resumes on step 3 after the paywall closes', async () => {
    await mount(<Shell />);
    await raiseWalkthrough();
    await press('walkthrough-advance');
    await press('walkthrough-advance');
    expect(text()).toContain(WALKTHROUGH_STEPS[2]!.headline);

    await update(<Shell paywall />);
    expect(overlays()).toHaveLength(0);
    await update(<Shell />);
    expect(stageIds()).toEqual(['first-run-walkthrough']);
    expect(text()).toContain(WALKTHROUGH_STEPS[2]!.headline);
    expect(text()).not.toContain(WALKTHROUGH_STEPS[0]!.headline);
  });
});

describe('attack: boundary values for a numeric trigger', () => {
  it.each([Number.NaN, -1, 0, Number.POSITIVE_INFINITY])(
    'restoreFocusToTrigger(%p) is not a focusable node: it returns false and never reaches the native accessibility bridge',
    trigger => {
      expect(restoreFocusToTrigger(trigger)).toBe(false);
      expect(setFocus).not.toHaveBeenCalled();
    },
  );

  it('a positive integer handle is focused as-is', () => {
    expect(restoreFocusToTrigger(42)).toBe(true);
    expect(setFocus).toHaveBeenCalledWith(42);
  });
});
