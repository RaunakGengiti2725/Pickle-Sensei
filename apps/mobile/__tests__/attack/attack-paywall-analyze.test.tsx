/**
 * ADVERSARIAL PASS 3 — mobile-billing-paywall (S4).
 *
 * AnalyzeScreen reaches an `unavailable / paywall_required` outcome while a
 * PaywallScreen is mounted on top of it (the user tapped "Upgrade to Pro").
 * When the navigator later unmounts Analyze, its cleanup calls
 * refreshAccess(), which drives the access store through status 'loading'.
 * The Paywall podium must survive that transition, the store must be asked
 * for the ledger exactly once, and the app must register a single Paywall
 * route that both the gate and Analyze target.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { CapturedClip } from '../../src/camera/capture';
import type { CaptureAnalysisOutcome } from '../../src/analysis/runCaptureAnalysis';

const mockNavigation = {
  replace: jest.fn(),
  goBack: jest.fn(),
  navigate: jest.fn(),
  popToTop: jest.fn(),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: { source: 'camera' } }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
  };
});
jest.mock('react-native-linear-gradient', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-svg', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});
jest.mock('../../src/data/db', () => ({ getDb: () => mockCurrentDb() }));

let mockCaptureImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('capture mock not configured'));
jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual('../../src/camera/capture');
  return {
    ...actual,
    captureStrokeVideo: () => mockCaptureImpl(),
    importStrokeVideo: () => Promise.reject(new Error('out of scope')),
    cancelCameraOperation: () => undefined,
    subscribeToCameraEvents: () => () => undefined,
  };
});

let mockOutcome: () => Promise<CaptureAnalysisOutcome> = () =>
  Promise.reject(new Error('outcome not configured'));
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: () => mockOutcome(),
}));

import { AnalyzeScreen } from '../../src/screens/AnalyzeScreen';
import { PaywallScreen } from '../../src/screens/PaywallScreen';
import { PressableScale } from '../../src/design/components';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  StorePlans,
} from '../../src/billing/types';

const owner = '22222222-2222-4222-8222-222222222222';

const recordingDb: LocalDb = {
  async execute() {
    return { rows: [] };
  },
  close() {},
};
function mockCurrentDb(): LocalDb {
  return recordingDb;
}

function freeAccess(used: number, reserved = 0): CanonicalAccessState {
  const remaining = 2 - used;
  const availableToReserve = remaining - reserved;
  return {
    premium: false,
    entitlements: [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating: availableToReserve > 0,
    paywallRequired: availableToReserve <= 0,
  };
}

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'default:annual:$rc_annual:pickle_sensei_pro_annual',
    productId: 'pickle_sensei_pro_annual',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: {
    id: 'default:monthly:$rc_monthly:pickle_sensei_pro_monthly',
    productId: 'pickle_sensei_pro_monthly',
    period: 'monthly',
    price: 7.99,
    priceString: '$7.99',
    pricePerMonthString: '$7.99',
    freeTrial: null,
  },
  lifetime: {
    id: 'default:lifetime:$rc_lifetime:pickle_sensei_pro_lifetime',
    productId: 'pickle_sensei_pro_lifetime',
    period: 'lifetime',
    price: 159.99,
    priceString: '$159.99',
    pricePerMonthString: null,
    freeTrial: null,
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function dependencies(
  getAccess: () => Promise<CanonicalAccessState>,
): BillingAccessDependencies & {
  backend: { getAccess: jest.Mock; syncBilling: jest.Mock };
} {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(),
      restore: jest.fn(),
      readEntitlement: jest.fn(),
    },
    backend: { getAccess: jest.fn(getAccess), syncBilling: jest.fn() },
  };
}

function guidedClip(): CapturedClip {
  return {
    uri: 'file:///captures/run.mov',
    durationMs: 2700,
    fps: 60,
    width: 1080,
    height: 1080,
    capturedAtIso: '2026-09-02T18:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 2000,
      endMs: 2700,
      peakMotionMs: 2400,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    targetSeed: { x: 0.5, y: 0.6, source: 'live_camera_tap' },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: 40,
      poseFrameCount: 40,
      poseMissingFrameCount: 0,
      trackedDurationMs: 2700,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: 40,
      jointMotion: [],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 2000,
    postRollMs: 1500,
  };
}

const PAYWALL_REQUIRED_REASON =
  'Your two free ratings are used. Upgrade to Pro to keep scoring.';

function paywallRequiredOutcome(): CaptureAnalysisOutcome {
  return {
    kind: 'unavailable',
    reason: PAYWALL_REQUIRED_REASON,
    cause: 'paywall_required',
  };
}

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(() => resolve(undefined), 0));
  });
}

async function waitFor(condition: () => boolean, what: string) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await act(async () => {
      await new Promise(resolve => setTimeout(() => resolve(undefined), 10));
    });
  }
}

function pressByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with accessibilityLabel ${label}`);
  act(() => node.props.onPress());
}

function buttonsLabelled(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  return renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      n.findAll(t => t.type === Text && String(t.props.children) === label)
        .length > 0,
  );
}

function pressButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const candidates = buttonsLabelled(renderer, label);
  const node = candidates[candidates.length - 1];
  if (!node) throw new Error(`No button labeled ${label}`);
  act(() => node.props.onPress());
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function paywallPressable(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  return renderer.root.findAll(
    n => n.type === PressableScale && n.props.testID === testID,
  );
}

function podiumColumns(renderer: TestRenderer.ReactTestRenderer) {
  return ['annual', 'monthly', 'lifetime'].filter(
    period => paywallPressable(renderer, `paywall-plan-${period}`).length > 0,
  );
}

function progressBars(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    n => n.props.accessibilityRole === 'progressbar',
  );
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

async function renderAnalyze() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<AnalyzeScreen />);
  });
  mounted.push(renderer);
  return renderer;
}

async function renderPaywallOnPricing() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PaywallScreen
        onClose={jest.fn()}
        onPurchased={jest.fn()}
        onOpenTerms={jest.fn()}
        onOpenPrivacy={jest.fn()}
      />,
    );
  });
  mounted.push(renderer);
  await flush();
  await act(async () => {
    paywallPressable(renderer, 'paywall-see-plans')[0]!.props.onPress();
  });
  await flush();
  return renderer;
}

/** Declares a stroke and runs one zero-touch capture to the mocked outcome. */
async function runOneAnalysis(renderer: TestRenderer.ReactTestRenderer) {
  pressByLabel(renderer, 'Forehand Drive');
  mockCaptureImpl = async () => guidedClip();
  pressButton(renderer, 'Open automatic camera');
  await flush();
}

beforeEach(() => {
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  mockNavigation.replace.mockClear();
  mockNavigation.navigate.mockClear();
  act(() => clearAccessStoreConfiguration());
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => {
      try {
        renderer.unmount();
      } catch {
        // already unmounted by the test
      }
    });
  }
  act(() => clearAccessStoreConfiguration());
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

function seedAdmittedSnapshot(clients: BillingAccessDependencies) {
  act(() => {
    configureAccessStore(clients);
    useAccessStore.setState({
      status: 'ready',
      plans,
      selectedPeriod: 'annual',
      canonicalAccess: freeAccess(1),
    });
  });
}

describe('S4 — paywall_required on Analyze with the Paywall mounted on top', () => {
  it('Analyze unmount → refreshAccess (status loading) keeps the podium, CTA and allowance copy intact', async () => {
    const refresh = deferred<CanonicalAccessState>();
    const clients = dependencies(() => refresh.promise);
    // Snapshot the gate admitted this visit on: one rating still available.
    seedAdmittedSnapshot(clients);

    mockOutcome = async () => paywallRequiredOutcome();
    const analyze = await renderAnalyze();
    await runOneAnalysis(analyze);
    await waitFor(
      () => buttonsLabelled(analyze, 'Upgrade to Pro').length > 0,
      'Upgrade to Pro recovery',
    );
    expect(allText(analyze)).toContain(PAYWALL_REQUIRED_REASON);
    // The 402 is NOT written into the store while Analyze is mounted.
    expect(clients.backend.getAccess).not.toHaveBeenCalled();
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(1));

    // Rapid double tap: both taps target the same single route with the same
    // params — the navigator's navigate() semantics (focus existing route)
    // make this idempotent; there is no second Paywall registration to hit.
    pressButton(analyze, 'Upgrade to Pro');
    pressButton(analyze, 'Upgrade to Pro');
    expect(mockNavigation.navigate).toHaveBeenCalledTimes(2);
    for (const call of mockNavigation.navigate.mock.calls) {
      expect(call).toEqual(['Paywall', { source: 'rating' }]);
    }
    expect(mockNavigation.replace).not.toHaveBeenCalled();

    // The navigator mounts the Paywall on top; Analyze is still in the stack.
    const paywall = await renderPaywallOnPricing();
    expect(podiumColumns(paywall)).toEqual(['annual', 'monthly', 'lifetime']);
    expect(progressBars(paywall)).toHaveLength(0);
    expect(paywallPressable(paywall, 'paywall-retry')).toHaveLength(0);
    const continueBefore = paywallPressable(paywall, 'paywall-continue')[0]!;
    expect(continueBefore.props.disabled).toBe(false);
    expect(continueBefore.props.accessibilityLabel).toBe(
      'Continue · $59.99/yr',
    );
    expect(allText(paywall)).toContain(
      '1 of your 2 lifetime free ratings remain.',
    );

    // Analyze leaves the stack: its cleanup re-reads the ledger.
    await act(async () => analyze.unmount());
    await flush();
    expect(clients.backend.getAccess).toHaveBeenCalledTimes(1);
    expect(useAccessStore.getState().status).toBe('loading');

    // While loading: podium, CTA and the last known allowance copy stay.
    expect(podiumColumns(paywall)).toEqual(['annual', 'monthly', 'lifetime']);
    expect(progressBars(paywall)).toHaveLength(0);
    expect(paywallPressable(paywall, 'paywall-retry')).toHaveLength(0);
    expect(allText(paywall)).not.toContain('Loading secure store pricing');
    expect(allText(paywall)).not.toContain('Store pricing is unavailable');
    const continueDuring = paywallPressable(paywall, 'paywall-continue')[0]!;
    expect(continueDuring.props.disabled).toBe(false);
    expect(continueDuring.props.accessibilityLabel).toBe(
      'Continue · $59.99/yr',
    );

    // The server's verdict lands: still the same podium, copy flips to used-up.
    refresh.resolve(freeAccess(2));
    await flush();
    expect(useAccessStore.getState().status).toBe('ready');
    expect(useAccessStore.getState().canonicalAccess).toEqual(freeAccess(2));
    expect(podiumColumns(paywall)).toEqual(['annual', 'monthly', 'lifetime']);
    expect(paywallPressable(paywall, 'paywall-retry')).toHaveLength(0);
    expect(allText(paywall)).toContain(
      'Both lifetime free ratings have been successfully scored.',
    );
    expect(
      paywallPressable(paywall, 'paywall-continue')[0]!.props.disabled,
    ).toBe(false);
    act(() => paywall.unmount());
  });

  it('a FAILED refresh after Analyze unmounts fails closed on the Paywall (CTA disabled, Retry shown) without hiding the podium', async () => {
    const clients = dependencies(async () => {
      throw new Error('offline');
    });
    seedAdmittedSnapshot(clients);
    mockOutcome = async () => paywallRequiredOutcome();
    const analyze = await renderAnalyze();
    await runOneAnalysis(analyze);
    await waitFor(
      () => buttonsLabelled(analyze, 'Upgrade to Pro').length > 0,
      'Upgrade to Pro recovery',
    );
    pressButton(analyze, 'Upgrade to Pro');
    const paywall = await renderPaywallOnPricing();

    await act(async () => analyze.unmount());
    await flush();
    const state = useAccessStore.getState();
    expect(state.status).toBe('error');
    expect(state.canonicalAccess).toBeNull();
    expect(state.plans).toEqual(plans);
    expect(podiumColumns(paywall)).toEqual(['annual', 'monthly', 'lifetime']);
    expect(
      paywallPressable(paywall, 'paywall-continue')[0]!.props.disabled,
    ).toBe(true);
    expect(paywallPressable(paywall, 'paywall-retry')).toHaveLength(1);
    expect(allText(paywall)).toContain(
      'Membership verification is temporarily unavailable.',
    );
    act(() => paywall.unmount());
  });

  it('an unmount while a purchase is in flight does not disturb the purchasing CTA state', async () => {
    const refresh = deferred<CanonicalAccessState>();
    const clients = dependencies(() => refresh.promise);
    const pendingPurchase = deferred<{
      premium: boolean;
      productId: string | null;
      expirationDate: string | null;
    }>();
    (clients.store.purchase as jest.Mock).mockImplementation(
      () => pendingPurchase.promise,
    );
    seedAdmittedSnapshot(clients);
    mockOutcome = async () => paywallRequiredOutcome();
    const analyze = await renderAnalyze();
    await runOneAnalysis(analyze);
    await waitFor(
      () => buttonsLabelled(analyze, 'Upgrade to Pro').length > 0,
      'Upgrade to Pro recovery',
    );
    pressButton(analyze, 'Upgrade to Pro');
    const paywall = await renderPaywallOnPricing();
    await act(async () => {
      paywallPressable(paywall, 'paywall-continue')[0]!.props.onPress();
    });
    await flush();
    expect(useAccessStore.getState().operation).toBe('purchasing');

    await act(async () => analyze.unmount());
    await flush();
    expect(useAccessStore.getState().status).toBe('loading');
    expect(useAccessStore.getState().operation).toBe('purchasing');
    expect(
      paywallPressable(paywall, 'paywall-continue')[0]!.props.disabled,
    ).toBe(true);
    expect(podiumColumns(paywall)).toEqual(['annual', 'monthly', 'lifetime']);
    // Second tap while pending must not dispatch a second purchase.
    await act(async () => {
      paywallPressable(paywall, 'paywall-continue')[0]!.props.onPress();
    });
    expect(clients.store.purchase).toHaveBeenCalledTimes(1);
    refresh.resolve(freeAccess(2));
    pendingPurchase.reject(new Error('cancelled'));
    await flush();
    expect(useAccessStore.getState().operation).toBe('idle');
    act(() => paywall.unmount());
  });
});

// The mobile tsconfig has no Node types.
declare const require: (id: string) => unknown;
declare const __dirname: string;

describe('S4 — a single Paywall route', () => {
  const { readFileSync } = require('fs') as {
    readFileSync: (path: string, encoding: 'utf8') => string;
  };
  const { join } = require('path') as {
    join: (...parts: string[]) => string;
  };
  const src = (relative: string) =>
    readFileSync(join(__dirname, '..', '..', 'src', relative), 'utf8');

  it('RootNavigator registers exactly one Paywall screen and the gate REPLACES into it', () => {
    const navigator = src('navigation/RootNavigator.tsx');
    expect(navigator.match(/name="Paywall"/g) ?? []).toHaveLength(1);
    expect(
      navigator.match(/<Stack\.Screen[\s\S]*?name="Paywall"/g) ?? [],
    ).toHaveLength(1);
    expect(navigator).toContain("navigation.replace('Paywall', { source })");
    expect(
      navigator.match(/navigation\.navigate\('Paywall'/g) ?? [],
    ).toHaveLength(0);
  });

  it('every Paywall entry point in the mobile app targets that one route with source rating', () => {
    const files = [
      'screens/AnalyzeScreen.tsx',
      'navigation/PremiumTabBar.tsx',
      'navigation/RootNavigator.tsx',
    ];
    const targets = files.flatMap(file =>
      (src(file).match(/(navigate|replace)\('Paywall'[^)]*\)/g) ?? []).map(
        (hit: string) => `${file}: ${hit}`,
      ),
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const hit of targets) {
      expect(hit).toMatch(/source(: 'rating'| \})/);
    }
  });
});
