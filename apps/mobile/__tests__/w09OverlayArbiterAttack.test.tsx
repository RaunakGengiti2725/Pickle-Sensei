/**
 * W09-04 adversarial suite — attacks the overlay/ceremony arbiter at its
 * failure boundaries: double submit, duplicate/preempting surfaces released
 * out of order, permission promise rejection, interleaved account switches,
 * process-like remount of the shell, reentrant trigger capture and the
 * paywall's own error notice. Each `it` is one attack; a failing assertion is
 * a confirmed break against candidate c6861581.
 */
import React from 'react';
import {
  AccessibilityInfo,
  AppState,
  Linking,
  Modal,
  View,
  type HostInstance,
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

/** Same host-tag shim as the candidate suite: the RN Jest preset renders
 * `View` as a class component, so `findNodeHandle` is resolved through the
 * instance's fibre to one stable tag per host element, recorded with its
 * accessibility label. */
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
      mockHostTag(instance) ?? actual.findNodeHandle(instance),
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
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
  useFocusEffect: () => undefined,
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
  identifyCeremony,
  openCeremonyFrom,
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

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
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
const LEGAL_TERMS_URL = 'https://example.invalid/terms';

let renderer: TestRenderer.ReactTestRenderer | undefined;
let unregister: Array<() => void>;
let announce: jest.SpyInstance;
let setFocus: jest.SpyInstance;

/** Mirrors RootNavigator.openLegalPage: a failed `Linking.openURL` from the
 * paywall's Terms/Privacy links is reported through `showBrandNotice`, the
 * product's one-way notice channel. */
async function openLegalPage(label: string, url: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch {
    showBrandNotice({
      title: `${label} could not be opened`,
      detail: `Your phone could not open the page. You can read it in a browser at ${url}`,
      tone: 'danger',
      eyebrow: 'LINK UNAVAILABLE',
    });
  }
}

/** The shipping composition (App.tsx): the global ceremony host with its
 * three stages beside the product-owned notice host, plus the paywall route
 * when it is on the navigation stack. */
function Shell(props: {
  ownerKey?: string;
  paywalls?: number;
  paywallLegalLinks?: boolean;
  trigger?: boolean;
}) {
  return (
    <>
      <CeremonyHost ownerKey={props.ownerKey ?? OWNER_A}>
        <RankUpCelebration />
        <StreakCelebration />
        <FirstRunWalkthrough />
      </CeremonyHost>
      <BrandNoticeHost />
      {props.trigger ? <ReplayTrigger /> : null}
      {Array.from({ length: props.paywalls ?? 0 }, (_, index) => (
        <PaywallScreen
          key={index}
          onClose={() => {}}
          {...(props.paywallLegalLinks
            ? {
                onOpenTerms: () =>
                  void openLegalPage('Terms of use', LEGAL_TERMS_URL),
              }
            : {})}
        />
      ))}
    </>
  );
}

/** A Settings-style row that replays the walkthrough on behalf of itself
 * (SettingsScreen.tsx: `openCeremonyFrom(walkthroughRow.current, replay)`). */
function ReplayTrigger() {
  const row = React.useRef<HostInstance>(null);
  return (
    <View
      ref={row}
      accessibilityLabel="App walkthrough, Replay"
      testID="replay-trigger"
      onClick={() =>
        openCeremonyFrom(row.current, () =>
          useWalkthroughStore.getState().replay(),
        )
      }
    />
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

function noticeTitle(): string {
  return renderer!.root.findByType(BrandDialog).props.title as string;
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

async function pressLabel(label: string) {
  const target = renderer!.root.findAll(
    node =>
      typeof node.type !== 'string' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  )[0]!;
  expect(target).toBeDefined();
  await act(async () => target.props.onPress());
}

async function raiseRank() {
  await act(async () => {
    await useRankCelebrationStore.getState().maybeCelebrate(summary);
  });
}

async function replayFromTrigger() {
  const trigger = renderer!.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.testID === 'replay-trigger' &&
      typeof node.props.onClick === 'function',
  )[0]!;
  expect(trigger).toBeDefined();
  await act(async () => trigger.props.onClick());
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

function resetStores() {
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
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-09-06T22:00:00Z') });
  mockKv.clear();
  mockKv.set(WALKTHROUGH_KV_KEY, WALKTHROUGH_SEEN_VALUE);
  nodeTags.clear();
  nextTag = 0;
  setActiveDataOwner(OWNER_A);
  resetStores();
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

describe('attack: the paywall’s own error notice', () => {
  it('Terms of use fails to open from the paywall: the failure notice is shown while the paywall is still on screen', async () => {
    jest
      .spyOn(Linking, 'openURL')
      .mockRejectedValue(new Error('No app can open this URL'));
    await mount(<Shell paywalls={1} paywallLegalLinks />);
    await press('paywall-see-plans');

    await pressLabel('Terms of use');
    await act(async () => {
      await Promise.resolve();
    });

    // The notice is the ONLY feedback for this tap (RootNavigator.openLegalPage);
    // the paywall stays open, so the user must see it now, not after closing.
    expect(noticeTitle()).toBe('Terms of use could not be opened');
    expect(noticeVisible()).toBe(true);
  });
});

describe('attack: double submit and duplicate surfaces', () => {
  it('two notices raised back to back while a rank-up shows: the survivor is the latest and it is shown exactly once', async () => {
    await mount(<Shell />);
    await raiseRank();
    await act(async () => {
      showBrandNotice({ title: 'First failure', detail: 'a' });
      showBrandNotice({ title: 'Second failure', detail: 'b' });
    });
    expect(noticeVisible()).toBe(false);
    expect(overlays()).toHaveLength(1);

    await press('rank-up-continue');
    expect(noticeVisible()).toBe(true);
    expect(noticeTitle()).toBe('Second failure');

    const dialog = renderer!.root.findByType(BrandDialog);
    await act(async () => dialog.props.onDismiss());
    expect(noticeVisible()).toBe(false);
    expect(overlays()).toHaveLength(0);
  });

  it('two paywall routes on the stack (double-tap push): the ceremony stays withdrawn until the LAST paywall leaves', async () => {
    await mount(<Shell />);
    await raiseRank();
    expect(overlays()).toHaveLength(1);

    await update(<Shell paywalls={2} />);
    expect(overlays()).toHaveLength(0);
    await update(<Shell paywalls={1} />);
    expect(overlays()).toHaveLength(0);
    expect(useRankCelebrationStore.getState().current).not.toBeNull();
    await update(<Shell paywalls={0} />);
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
  });

  it('two concurrent permission requests (priming card + settings toggle): the ceremony returns only after BOTH resolve, once', async () => {
    await mount(<Shell />);
    await raiseRank();
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
    expect(overlays()).toHaveLength(0);

    await act(async () => {
      first.resolve('denied');
      await firstOutcome;
    });
    expect(overlays()).toHaveLength(0);

    announce.mockClear();
    await act(async () => {
      second.resolve('denied');
      await secondOutcome;
    });
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith(RANK_ANNOUNCEMENT);
  });
});

describe('attack: preempting surfaces released out of order', () => {
  it('permission sheet then paywall; the sheet resolves first: the paywall keeps the slot, the ceremony returns after the paywall', async () => {
    await mount(<Shell />);
    await raiseRank();
    const prompt = deferred<PermissionState>();
    let outcome: Promise<boolean> | undefined;
    await act(async () => {
      outcome = useNotificationStore.getState().requestPermissionAndEnable({
        scheduler: scheduler(() => prompt.promise),
      });
    });
    await update(<Shell paywalls={1} />);
    expect(overlays()).toHaveLength(0);

    await act(async () => {
      prompt.resolve('granted');
      await outcome;
    });
    expect(overlays()).toHaveLength(0);
    await update(<Shell paywalls={0} />);
    expect(overlays()).toHaveLength(1);
  });

  it('the permission request REJECTS (native module failure): the slot is released and the ceremony comes back', async () => {
    await mount(<Shell />);
    await raiseRank();
    const prompt = deferred<PermissionState>();
    let outcome: Promise<boolean> | undefined;
    await act(async () => {
      outcome = useNotificationStore.getState().requestPermissionAndEnable({
        scheduler: scheduler(() => prompt.promise),
      });
    });
    expect(overlays()).toHaveLength(0);

    await act(async () => {
      prompt.reject(new Error('UNUserNotificationCenter unavailable'));
      expect(await outcome).toBe(false);
    });
    expect(useNotificationStore.getState().permission).toBe('unknown');
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
  });

  it('onboarding "enable" whose sheet rejects releases the slot as well', async () => {
    await mount(<Shell />);
    await raiseRank();
    let outcome: Promise<boolean> | undefined;
    await act(async () => {
      outcome = useNotificationStore
        .getState()
        .completeOnboardingStep('enable', {
          scheduler: scheduler(() => Promise.reject(new Error('boom'))),
        });
    });
    await act(async () => {
      expect(await outcome).toBe(false);
    });
    expect(overlays()).toHaveLength(1);
  });
});

describe('attack: interleaved account switch', () => {
  it('owner A replays from Settings, A → B → A: the device-level tour survives the switch, and focus returns to the row exactly once on dismissal', async () => {
    await mount(<Shell trigger />);
    await replayFromTrigger();
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['first-run-walkthrough']);

    setActiveDataOwner(OWNER_B);
    await update(<Shell trigger ownerKey={OWNER_B} />);
    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(setFocus).not.toHaveBeenCalled();

    setActiveDataOwner(OWNER_A);
    await update(<Shell trigger ownerKey={OWNER_A} />);
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['first-run-walkthrough']);

    await press('walkthrough-skip');
    expect(overlays()).toHaveLength(0);
    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(setFocus).toHaveBeenCalledTimes(1);
    const [tag] = setFocus.mock.calls[0] as [number];
    expect(nodeTags.get(tag)).toBe('App walkthrough, Replay');
  });

  it('a notice raised for owner A stays hidden behind A’s rank-up, and switching to B does not leak the ceremony slot to the notice while B has nothing to show', async () => {
    await mount(<Shell />);
    await raiseRank();
    await act(async () =>
      showBrandNotice({ title: 'Sync failed', detail: 'x' }),
    );
    expect(noticeVisible()).toBe(false);

    setActiveDataOwner(OWNER_B);
    await update(<Shell ownerKey={OWNER_B} />);
    expect(overlays()).toHaveLength(0);
    // Nothing else is on screen for B: the product-owned notice must not be
    // stuck behind a ceremony that is no longer presented.
    expect(noticeVisible()).toBe(true);
  });
});

describe('attack: process-like restart of the shell', () => {
  it('unmounting the whole shell while a notice is presented and a ceremony is queued leaves no orphan claim: a fresh shell presents immediately', async () => {
    await mount(<Shell />);
    await act(async () =>
      showBrandNotice({ title: 'Sync failed', detail: 'x' }),
    );
    await raiseRank();
    expect(noticeVisible()).toBe(true);
    expect(overlays()).toHaveLength(0);

    await act(async () => renderer!.unmount());
    renderer = undefined;

    await mount(<Shell />);
    expect(overlays()).toHaveLength(1);
    expect(stageIds()).toEqual(['rank-up-celebration']);
    expect(noticeVisible()).toBe(false);
  });

  it('a stray claim that is never released (e.g. a permission promise that never settles) does not survive; releasing twice is harmless', () => {
    const claim = claimSurface('permission');
    claim.release();
    claim.release();
    const probe = claimSurface('ceremony');
    probe.release();
    probe.release();
  });
});

describe('attack: reentrant trigger capture', () => {
  it('a throwing `open` restores the previous pending trigger; a nested open keeps its own trigger', () => {
    const outer = 1001;
    const inner = 2002;
    expect(() =>
      openCeremonyFrom(outer, () => {
        throw new Error('open failed');
      }),
    ).toThrow('open failed');
    expect(identifyCeremony({}).trigger).toBeNull();

    const nested = openCeremonyFrom(outer, () =>
      openCeremonyFrom(inner, () => identifyCeremony({})),
    );
    expect(nested.trigger).toBe(inner);
    expect(identifyCeremony({}).trigger).toBeNull();
  });

  it('replay tapped twice while the tour is already up: the second tap opens nothing and leaves no trigger behind', async () => {
    await mount(<Shell trigger />);
    await replayFromTrigger();
    await replayFromTrigger();
    expect(overlays()).toHaveLength(1);
    expect(identifyCeremony({}).trigger).toBeNull();
    await press('walkthrough-skip');
    expect(setFocus).toHaveBeenCalledTimes(1);
  });
});

describe('attack: announcements under preemption', () => {
  it('a walkthrough preempted mid-tour and re-presented resumes the step it was on (no restart, no stale step announced)', async () => {
    await mount(<Shell />);
    await act(async () => {
      useWalkthroughStore.getState().replay();
    });
    await press('walkthrough-advance');
    await press('walkthrough-advance');
    expect(announce).toHaveBeenCalledTimes(3);
    expect(announce).toHaveBeenLastCalledWith(
      expect.stringContaining(
        `Walkthrough, step 3 of ${WALKTHROUGH_STEPS.length}.`,
      ),
    );

    const prompt = deferred<PermissionState>();
    let outcome: Promise<boolean> | undefined;
    await act(async () => {
      outcome = useNotificationStore.getState().requestPermissionAndEnable({
        scheduler: scheduler(() => prompt.promise),
      });
    });
    expect(overlays()).toHaveLength(0);
    await act(async () => {
      prompt.resolve('denied');
      await outcome;
    });
    expect(overlays()).toHaveLength(1);
    expect(announce).toHaveBeenLastCalledWith(
      expect.stringContaining(
        `Walkthrough, step 3 of ${WALKTHROUGH_STEPS.length}.`,
      ),
    );
  });
});
