/**
 * W09-04 — adversarial attacks on the overlay/ceremony arbiter.
 *
 * Each test drives the candidate at an interleaving the regression suite
 * does not pin: surfaces raised while another is presented, held or
 * withdrawn; chained ceremonies with a captured trigger; blockers that
 * reject, overlap or outlive the tree; account-owner changes while a
 * ceremony is withheld; and re-entrant arbiter listeners. A failing test
 * here is a candidate break, not a suite defect — the assertions state the
 * behaviour the objective promises ("only one is presented, focus returns
 * to the trigger, and announcements are made once").
 */
import React from 'react';
import { AccessibilityInfo, AppState, Modal, View } from 'react-native';
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
  openCeremonyFrom,
  presentedSurfaceId,
  restoreFocusToTrigger,
  subscribeToSurfaces,
  type SurfaceClaim,
} from '../src/flow/ceremonyRequest';
import { RankUpCelebration } from '../src/components/RankUpCelebration';
import { StreakCelebration } from '../src/consistency/StreakCelebration';
import { FirstRunWalkthrough } from '../src/walkthrough/FirstRunWalkthrough';
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

function Shell(props: { paywall?: boolean; ownerKey?: string }) {
  return (
    <>
      <CeremonyHost ownerKey={props.ownerKey ?? OWNER}>
        <RankUpCelebration />
        <StreakCelebration />
        <FirstRunWalkthrough />
      </CeremonyHost>
      <BrandNoticeHost />
      {props.paywall ? <PaywallScreen onClose={() => {}} /> : null}
    </>
  );
}

/** App.tsx shape: Settings (owning the Replay row) beside the global host
 * that presents both the walkthrough and the rank-up ceremony. */
function SettingsWithCeremonies(props: { signedIn?: boolean }) {
  return (
    <View>
      {(props.signedIn ?? true) ? <SettingsScreen /> : null}
      <CeremonyHost ownerKey={OWNER}>
        <RankUpCelebration />
        <FirstRunWalkthrough />
      </CeremonyHost>
      <BrandNoticeHost />
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

function noticeTitle(): string | null {
  if (!noticeVisible()) return null;
  return renderer!.root.findByType(BrandDialog).props.title as string;
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

function replayRow() {
  return renderer!.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.accessibilityLabel === 'App walkthrough, Replay' &&
      typeof node.props.onClick === 'function',
  )[0]!;
}

async function raiseRank(content: PlayerRankSummary = summary) {
  await act(async () => {
    await useRankCelebrationStore.getState().maybeCelebrate(content);
  });
}

function notice(title: string) {
  return act(async () =>
    showBrandNotice({
      title,
      detail: 'Your phone could not open the page.',
      tone: 'danger',
      eyebrow: 'LINK UNAVAILABLE',
    }),
  );
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
  expect(presentedSurfaceId()).toBeNull();
});

describe('attack: replay / duplicate identities — error notices raised while held', () => {
  it('two distinct error notices raised behind a showing ceremony are both shown once the ceremony is dismissed', async () => {
    await mount(<Shell />);
    await raiseRank();
    expect(overlays()).toHaveLength(1);

    await notice('Privacy policy could not be opened');
    await notice('Terms of use could not be opened');
    expect(overlays()).toHaveLength(1);
    expect(noticeVisible()).toBe(false);

    const shown: string[] = [];
    await press('rank-up-continue');
    expect(overlays()).toHaveLength(0);
    expect(noticeVisible()).toBe(true);
    shown.push(noticeTitle()!);
    await dismissNotice();
    if (noticeVisible()) shown.push(noticeTitle()!);

    expect(shown).toEqual([
      'Privacy policy could not be opened',
      'Terms of use could not be opened',
    ]);
  });

  it('the same error notice raised twice behind a ceremony is shown once, not lost', async () => {
    await mount(<Shell />);
    await raiseRank();
    await notice('Video unavailable');
    await notice('Video unavailable');
    await press('rank-up-continue');
    expect(overlays()).toHaveLength(0);
    expect(noticeTitle()).toBe('Video unavailable');
    await dismissNotice();
    expect(noticeVisible()).toBe(false);
  });

  it('a rapid double-tap on Settings → Replay presents one tour, announces once and restores focus once', async () => {
    seedSettingsStores();
    await mount(<SettingsWithCeremonies />);
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
    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(setFocus).toHaveBeenCalledTimes(1);
    const [tag] = setFocus.mock.calls[0] as [number];
    expect(nodeTags.get(tag)).toBe('App walkthrough, Replay');
  });
});

describe('attack: concurrency — permission sheet, notice and ceremony three ways', () => {
  it('a notice and a rank-up both raised while the permission sheet is up: notice first, ceremony after, ceremony announced exactly once', async () => {
    await mount(<Shell />);
    const prompt = deferred<PermissionState>();
    let outcome: Promise<boolean> | undefined;
    await act(async () => {
      outcome = useNotificationStore.getState().requestPermissionAndEnable({
        scheduler: scheduler(() => prompt.promise),
      });
    });

    await raiseRank();
    await notice('Video unavailable');
    expect(overlays()).toHaveLength(0);
    expect(noticeVisible()).toBe(false);
    expect(announce).not.toHaveBeenCalled();

    await act(async () => {
      prompt.resolve('denied');
      await outcome;
    });
    expect(noticeVisible()).toBe(true);
    expect(overlays()).toHaveLength(0);

    await dismissNotice();
    expect(noticeVisible()).toBe(false);
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(
      announce.mock.calls.filter(c => c[0] === RANK_ANNOUNCEMENT),
    ).toHaveLength(1);
  });

  it('the native permission request rejects: the blocker is released and the held ceremony presents', async () => {
    await mount(<Shell />);
    const prompt = deferred<PermissionState>();
    let outcome: Promise<boolean> | undefined;
    await act(async () => {
      outcome = useNotificationStore.getState().requestPermissionAndEnable({
        scheduler: scheduler(() => prompt.promise),
      });
    });
    await raiseRank();
    expect(overlays()).toHaveLength(0);

    await act(async () => {
      prompt.reject(new Error('UNUserNotificationCenter unavailable'));
      await expect(outcome).resolves.toBe(false);
    });
    expect(useNotificationStore.getState().permission).toBe('unknown');
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
  });

  it('two overlapping permission requests: the ceremony stays withheld until the LAST sheet settles', async () => {
    await mount(<Shell />);
    const first = deferred<PermissionState>();
    const second = deferred<PermissionState>();
    let firstOutcome: Promise<boolean> | undefined;
    let secondOutcome: Promise<boolean> | undefined;
    await act(async () => {
      firstOutcome = useNotificationStore
        .getState()
        .requestPermissionAndEnable({
          scheduler: scheduler(() => first.promise),
        });
      secondOutcome = useNotificationStore
        .getState()
        .requestPermissionAndEnable({
          scheduler: scheduler(() => second.promise),
        });
    });
    await raiseRank();
    expect(overlays()).toHaveLength(0);

    await act(async () => {
      first.resolve('denied');
      await firstOutcome;
    });
    expect(overlays()).toHaveLength(0);

    await act(async () => {
      second.resolve('denied');
      await secondOutcome;
    });
    expect(overlays()).toHaveLength(1);
    expect(
      announce.mock.calls.filter(c => c[0] === RANK_ANNOUNCEMENT),
    ).toHaveLength(1);
  });
});

describe('attack: focus restoration with chained ceremonies', () => {
  it('a rank-up queued behind the replayed tour: focus returns to the Replay row only once every chained ceremony is gone', async () => {
    seedSettingsStores();
    await mount(<SettingsWithCeremonies />);
    await act(async () => replayRow().props.onClick());
    expect(stageIds()).toEqual(['first-run-walkthrough']);

    await raiseRank();
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['first-run-walkthrough']);

    await press('walkthrough-skip');
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
    const focusCallsWhileRankUpPresented = setFocus.mock.calls.length;

    await press('rank-up-continue');
    expect(overlays()).toHaveLength(0);
    const tags = (setFocus.mock.calls as Array<[number]>).map(([tag]) =>
      nodeTags.get(tag),
    );
    // VoiceOver focus must not be pushed onto a row that another modal
    // surface covers in the same frame; it should land on the row once the
    // chain of ceremonies it opened has fully cleared.
    expect({ focusCallsWhileRankUpPresented, tags }).toEqual({
      focusCallsWhileRankUpPresented: 0,
      tags: ['App walkthrough, Replay'],
    });
  });

  it('a notice waiting behind the replayed tour: focus is not fought over with the notice modal', async () => {
    seedSettingsStores();
    await mount(<SettingsWithCeremonies />);
    await act(async () => replayRow().props.onClick());
    await notice('Video unavailable');
    expect(noticeVisible()).toBe(false);

    await press('walkthrough-skip');
    expect(overlays()).toHaveLength(0);
    expect(noticeVisible()).toBe(true);
    const focusCallsWhileNoticePresented = setFocus.mock.calls.length;

    await dismissNotice();
    expect(noticeVisible()).toBe(false);
    expect({
      focusCallsWhileNoticePresented,
      focusCallsAfterNotice: setFocus.mock.calls.length,
    }).toEqual({ focusCallsWhileNoticePresented: 0, focusCallsAfterNotice: 1 });
  });

  it('the tour is withdrawn by the paywall and comes back: its trigger survives and focus still returns to the row', async () => {
    seedSettingsStores();
    await mount(
      <View>
        <SettingsScreen />
        <CeremonyHost ownerKey={OWNER}>
          <FirstRunWalkthrough />
        </CeremonyHost>
        <BrandNoticeHost />
      </View>,
    );
    await act(async () => replayRow().props.onClick());
    expect(overlays()).toHaveLength(1);

    const paywall = claimSurface('paywall');
    await act(async () => {});
    expect(overlays()).toHaveLength(0);
    expect(useWalkthroughStore.getState().visible).toBe(true);

    await act(async () => paywall.release());
    expect(overlays()).toHaveLength(1);
    await press('walkthrough-skip');
    expect(setFocus).toHaveBeenCalledTimes(1);
    const [tag] = setFocus.mock.calls[0] as [number];
    expect(nodeTags.get(tag)).toBe('App walkthrough, Replay');
  });
});

describe('attack: account owner changes while a ceremony is withheld', () => {
  it("an owner switch while the rank-up is held behind the paywall: the old owner's ceremony never presents for the new owner", async () => {
    await mount(<Shell />);
    await raiseRank();
    expect(overlays()).toHaveLength(1);
    await update(<Shell paywall />);
    expect(overlays()).toHaveLength(0);

    setActiveDataOwner(OTHER_OWNER);
    await update(<Shell paywall ownerKey={OTHER_OWNER} />);
    await update(<Shell ownerKey={OTHER_OWNER} />);
    expect(overlays()).toHaveLength(0);
    expect(
      announce.mock.calls.filter(c => c[0] === RANK_ANNOUNCEMENT),
    ).toHaveLength(1);
  });

  it('sign-out while a notice waits behind a ceremony: the ceremony is withdrawn and the device-level notice is shown, once', async () => {
    await mount(<Shell />);
    await raiseRank();
    await notice('Video unavailable');
    expect(noticeVisible()).toBe(false);

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await update(<Shell ownerKey={SIGNED_OUT_DATA_OWNER} />);
    expect(overlays()).toHaveLength(0);
    expect(noticeVisible()).toBe(true);
    await dismissNotice();
    expect(noticeVisible()).toBe(false);
    expect(overlays()).toHaveLength(0);
  });
});

describe('attack: process death / remount with global arbiter state', () => {
  it('unmounting the whole tree while the paywall withholds a ceremony leaves no stale claim; a remount presents the ceremony', async () => {
    await mount(<Shell paywall />);
    await raiseRank();
    expect(overlays()).toHaveLength(0);
    expect(presentedSurfaceId()).toBeNull();

    await act(async () => renderer!.unmount());
    expect(presentedSurfaceId()).toBeNull();

    await mount(<Shell />);
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(
      announce.mock.calls.filter(c => c[0] === RANK_ANNOUNCEMENT),
    ).toHaveLength(1);
  });

  it('a notice and a ceremony both raised before any host exists: after mount exactly one shows, then the other', async () => {
    await act(async () =>
      showBrandNotice({
        title: 'Video unavailable',
        detail: '',
        tone: 'danger',
      }),
    );
    await act(async () => {
      await useRankCelebrationStore.getState().maybeCelebrate(summary);
    });
    await mount(<Shell />);
    const noticeFirst = noticeVisible();
    expect(overlays()).toHaveLength(noticeFirst ? 0 : 1);
    if (noticeFirst) {
      await dismissNotice();
      expect(overlays()).toHaveLength(1);
      expect(noticeVisible()).toBe(false);
    } else {
      await press('rank-up-continue');
      expect(overlays()).toHaveLength(0);
      expect(noticeTitle()).toBe('Video unavailable');
      await dismissNotice();
    }
    expect(noticeVisible()).toBe(false);
    expect(overlays()).toHaveLength(0);
  });

  it('the host remounts while a ceremony is presented: it is a new presentation, announced once more and no duplicate overlay', async () => {
    await mount(<Shell />);
    await raiseRank();
    expect(announce).toHaveBeenCalledTimes(1);
    await update(
      <>
        <CeremonyHost key="second" ownerKey={OWNER}>
          <RankUpCelebration />
        </CeremonyHost>
        <BrandNoticeHost />
      </>,
    );
    expect(overlays()).toHaveLength(1);
    expect(announce).toHaveBeenCalledTimes(2);
  });
});

describe('attack: arbiter re-entrancy and boundary values', () => {
  /** Every claim made directly in these tests is released even when an
   * assertion fails, so one failure cannot leak a presented surface into
   * the next test (the arbiter is module-global). */
  const held: SurfaceClaim[] = [];
  const subscriptions: Array<() => void> = [];
  function claim(kind: Parameters<typeof claimSurface>[0]): SurfaceClaim {
    const surface = claimSurface(kind);
    held.push(surface);
    return surface;
  }
  function listen(listener: () => void) {
    const unsubscribe = subscribeToSurfaces(listener);
    subscriptions.push(unsubscribe);
    return unsubscribe;
  }
  afterEach(() => {
    held.splice(0).forEach(surface => surface.release());
    subscriptions.splice(0).forEach(unsubscribe => unsubscribe());
  });

  it('a listener that claims a blocker and releases a slot during notification: every subscriber ends on the settled surface', () => {
    const seen: Array<number | null> = [];
    const ceremony = claim('ceremony');
    const notice = claim('notice');
    expect(presentedSurfaceId()).toBe(ceremony.id);
    const state: { permission: SurfaceClaim | null; claimed: boolean } = {
      permission: null,
      claimed: false,
    };
    listen(() => {
      seen.push(presentedSurfaceId());
      // Listeners are notified synchronously from inside claimSurface, before
      // the claim handle is returned — guard on a flag, not on the handle.
      if (!state.claimed) {
        state.claimed = true;
        state.permission = claim('permission');
      }
    });
    const observer = jest.fn(() => presentedSurfaceId());
    listen(observer);

    ceremony.release();
    expect(state.permission).not.toBeNull();
    expect(presentedSurfaceId()).toBeNull();
    expect(seen[seen.length - 1]).toBeNull();
    expect(
      observer.mock.results[observer.mock.results.length - 1]!.value,
    ).toBeNull();

    state.permission?.release();
    expect(presentedSurfaceId()).toBe(notice.id);
    expect(seen[seen.length - 1]).toBe(notice.id);
  });

  it('a subscriber added during notification receives later notifications', () => {
    const late = jest.fn();
    const state: { subscribed: boolean } = { subscribed: false };
    listen(() => {
      if (!state.subscribed) {
        state.subscribed = true;
        listen(late);
      }
    });
    const first = claim('ceremony');
    expect(state.subscribed).toBe(true);
    const before = late.mock.calls.length;
    first.release();
    expect(late.mock.calls.length).toBe(before + 1);
    expect(presentedSurfaceId()).toBeNull();
  });

  it('blockers released in either order: nothing presents while any blocker is held, then the waiting notice outranks the older ceremony', () => {
    const ceremony = claim('ceremony');
    const notice = claim('notice');
    expect(presentedSurfaceId()).toBe(ceremony.id);
    const paywall = claim('paywall');
    expect(presentedSurfaceId()).toBe(notice.id);
    const permission = claim('permission');
    expect(presentedSurfaceId()).toBeNull();
    paywall.release();
    expect(presentedSurfaceId()).toBeNull();
    permission.release();
    expect(presentedSurfaceId()).toBe(notice.id);
    notice.release();
    expect(presentedSurfaceId()).toBe(ceremony.id);
    ceremony.release();
    expect(presentedSurfaceId()).toBeNull();
  });

  it('double release and release of a never-presented claim are no-ops that cannot unseat the presented surface', () => {
    const ceremony = claim('ceremony');
    const waiting = claim('ceremony');
    waiting.release();
    waiting.release();
    expect(presentedSurfaceId()).toBe(ceremony.id);
    ceremony.release();
    ceremony.release();
    expect(presentedSurfaceId()).toBeNull();
  });

  it('1000 interleaved claims: the first presented surface is never unseated and each change presents exactly one id', () => {
    const claims: SurfaceClaim[] = [];
    const transitions: Array<number | null> = [];
    listen(() => transitions.push(presentedSurfaceId()));
    for (let i = 0; i < 1000; i += 1) {
      claims.push(claim(i % 2 === 0 ? 'ceremony' : 'notice'));
    }
    expect(presentedSurfaceId()).toBe(claims[0]!.id);
    expect(transitions).toEqual([claims[0]!.id]);
    claims[0]!.release();
    // Every notice (odd index) is presented before any remaining ceremony.
    expect(presentedSurfaceId()).toBe(claims[1]!.id);
    claims.slice(1).forEach(surface => surface.release());
    expect(presentedSurfaceId()).toBeNull();
    expect(new Set(transitions).size).toBe(transitions.length);
  });

  it('restoreFocusToTrigger with a detached/invalid handle does not throw and reports false or a focus call, never both', () => {
    expect(restoreFocusToTrigger({} as never)).toBe(false);
    expect(setFocus).not.toHaveBeenCalled();
    const numeric = restoreFocusToTrigger(42);
    expect(numeric).toBe(true);
    expect(setFocus).toHaveBeenCalledWith(42);
  });

  it('openCeremonyFrom that throws leaves no pending trigger for the next unrelated ceremony', async () => {
    seedSettingsStores();
    await mount(<SettingsWithCeremonies />);
    expect(() =>
      openCeremonyFrom(7, () => {
        throw new Error('open failed');
      }),
    ).toThrow('open failed');
    await raiseRank();
    expect(overlays()).toHaveLength(1);
    await press('rank-up-continue');
    expect(setFocus).not.toHaveBeenCalled();
  });
});
