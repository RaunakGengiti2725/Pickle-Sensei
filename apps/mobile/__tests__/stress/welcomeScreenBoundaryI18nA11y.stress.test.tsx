/**
 * STRESS scr-welcomescreen · lens boundary-i18n-a11y
 *
 * Mounts the REAL <App /> (SafeAreaProvider → QueryClientProvider →
 * RootErrorBoundary → Gate) against the real authStore / appStore /
 * notificationStore / consistencyStore / walkthroughStore, lets the real
 * SplashScreen hand off, and audits the WelcomeScreen the Gate lands on.
 * Only process edges are faked: SQLite (FakeLocalDb), Keychain (repo
 * __mocks__), Google Sign-In, notification scheduler, safe-area, SVG,
 * WebView, LinearGradient, I18nManager and `fetch`. A minority of rows mount
 * <WelcomeScreen /> directly so the optional-prop / undefined-callback
 * boundary can be exercised (App always passes both callbacks).
 *
 * Each seeded scenario varies: Dynamic Type fontScale (1 / 1.235 / 2.35 plus
 * 0 / -1 / 1e6), viewport (320 / 375 / 430 wide plus 0 / negative / 1e9),
 * safe-area insets, device locale (12, ar-EG under RTL), IANA timezone (8,
 * UTC+14 … UTC-12, DST edges) with the clock parked one second before a
 * transition, and a hostile persisted world (200+ char Latin / CJK / Arabic
 * RTL / Thai / Devanagari / German compounds / ZWJ emoji / combining marks /
 * bidi overrides / NUL bytes / 20k chars / non-JSON / extreme JSON numbers)
 * injected into the kv keys and Keychain record the launch actually reads.
 *
 * Invariants per row (BROKEN ⇒ the row fails with tree evidence):
 *   noCrash            no throw, RootErrorBoundary never renders, no console.error
 *   landsOnWelcome     the Gate reaches Welcome (splash gone, no LoadingState)
 *   noPayloadLeak      no hostile string reaches Welcome's text or labels
 *   a11yRoleLabel      every Pressable exposes a role and a non-empty label
 *   target44           every Pressable models ≥ 44pt tall and wide
 *   layoutFit          pinned footer fits the viewport; no Text is clipped by
 *                      numberOfLines; the ScrollView carries any overflow
 *   rtlSafe            no absolute textAlign left/right under RTL
 *   copyPolicy         APP_STORE_SUBMISSION.md forbidden terms / placeholders
 *   interaction        Start → onboarding, sign-in → sign-in screen (app);
 *                      callbacks fire exactly once (direct)
 *   noStrayFetch       signed-out launch makes no network call except the
 *                      vault-driven /v1/auth/refresh
 *
 * Artifacts: artifacts/stress-welcome/<run>/{rows.json,summary.json,failures.json}
 * Env: STRESS_ITER=<n> random rows (default 40; corner grid always runs),
 *      STRESS_SEED=<a,b,c> replay exactly those seeds,
 *      STRESS_BASE_SEED=<n> shift the campaign, STRESS_ARTIFACT_DIR=<path>.
 */
import React from 'react';
import { Dimensions, I18nManager, ScrollView, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type { PlannedNotification } from '../../src/notifications/types';
import { FakeLocalDb } from '../../xc-harness/lifecycle-persistence/fakeLocalDb';
import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  PressableInner,
  allText,
  auditPressables,
  compactTree,
  copyViolations,
  flat,
  modelText,
  textWidth,
  type LayoutContext,
  type PressableAudit,
  type TextRow,
} from '../../xc-harness/welcome-boundary/audit';
import {
  PAYLOADS,
  cornerScenarios,
  jsonEnvelopeFor,
  scenarioFromSeed,
  scenarioLabel,
  vaultEnvelopeFor,
  type Scenario,
} from '../../xc-harness/welcome-boundary/scenarios';

declare const __dirname: string;

// ─── Native seams ────────────────────────────────────────────────────────────

const mockDb = { current: new FakeLocalDb() };
jest.mock('../../src/data/db', () => ({
  getDb: () => mockDb.current.handle(),
}));

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(),
    signIn: jest.fn(),
    signInSilently: jest.fn(async () => {
      throw new Error('no silent google session (simulated)');
    }),
    hasPreviousSignIn: jest.fn(() => false),
    signOut: jest.fn(async () => {}),
    revokeAccess: jest.fn(async () => {}),
  },
}));

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'undetermined';
  applied: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.applied.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
  }
  async openSystemSettings(): Promise<void> {}
}
const mockScheduler = { current: new FakeScheduler() };
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler.current,
  screenTargetFromNotificationData: () => null,
  subscribeToNotificationPresses: () => () => {},
  registerBackgroundNotificationHandler: () => {},
}));

interface SafeAreaState {
  current: { top: number; bottom: number; left: number; right: number };
  frame: { x: number; y: number; width: number; height: number };
}
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const state: SafeAreaState = {
    current: { top: 20, bottom: 0, left: 0, right: 0 },
    frame: { x: 0, y: 0, width: 375, height: 667 },
  };
  return {
    __state: state,
    SafeAreaView: View,
    SafeAreaProvider: View,
    get initialWindowMetrics() {
      return { frame: state.frame, insets: state.current };
    },
    useSafeAreaInsets: () => state.current,
  };
});

interface RtlState {
  current: boolean;
  locale: string;
}
jest.mock('react-native/Libraries/ReactNative/I18nManager', () => {
  const state: RtlState = { current: false, locale: 'en_US' };
  return {
    __esModule: true,
    default: {
      __state: state,
      allowRTL: jest.fn(),
      forceRTL: jest.fn(),
      swapLeftAndRightInRTL: jest.fn(),
      get isRTL() {
        return state.current;
      },
      doLeftAndRightSwapInRTL: true,
      getConstants: () => ({
        isRTL: state.current,
        doLeftAndRightSwapInRTL: true,
        localeIdentifier: state.locale,
      }),
    },
  };
});

jest.mock('react-native-svg', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    R.createElement(View, null, props.children);
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
    G: Mock,
    Ellipse: Mock,
  };
});
jest.mock('react-native-webview', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    R.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});
jest.mock('react-native-linear-gradient', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    R.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

import * as Keychain from 'react-native-keychain';
import * as SafeAreaModule from 'react-native-safe-area-context';
import App from '../../App';
import { WelcomeScreen } from '../../src/screens/WelcomeScreen';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore } from '../../src/state/appStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import { clearApiSession } from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { space, type } from '../../src/design/tokens';

// The auto-mock (__mocks__/react-native-keychain.ts) exposes its in-memory
// store; it must be reached through the same import the app uses.
const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};
const mockSafeArea = (SafeAreaModule as unknown as { __state: SafeAreaState })
  .__state;
const mockRtl = (I18nManager as unknown as { __state: RtlState }).__state;

// ─── Campaign configuration ──────────────────────────────────────────────────

const START_LABEL = 'Start your first read';
const SIGN_IN_LABEL = 'I already have an account';
const ERROR_BOUNDARY_TITLE = 'Something went wrong';
const SPLASH_SETTLE_MS = 9_500; // SplashScreen WATCHDOG_MS (8s) + EXIT_MS + slack

function envInt(name: string, fallback: number): number {
  const raw = nodeProcess.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const BASE_SEED = envInt('STRESS_BASE_SEED', 4_242);
const RANDOM_ITER = envInt('STRESS_ITER', 40);
const SEED_FILTER = (nodeProcess.env['STRESS_SEED'] ?? '')
  .split(',')
  .map(s => Number.parseInt(s.trim(), 10))
  .filter(n => Number.isFinite(n));

function campaign(): Scenario[] {
  if (SEED_FILTER.length > 0) {
    const corners = cornerScenarios(BASE_SEED);
    return SEED_FILTER.map(
      seed => corners.find(c => c.seed === seed) ?? scenarioFromSeed(seed),
    );
  }
  const rows = cornerScenarios(BASE_SEED);
  for (let i = 0; i < RANDOM_ITER; i += 1) {
    rows.push(scenarioFromSeed(BASE_SEED + i));
  }
  return rows;
}

const SCENARIOS = campaign();

function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress-welcome');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Row model ───────────────────────────────────────────────────────────────

interface Row {
  seed: number;
  label: string;
  scenario: Scenario;
  invariants: Record<string, boolean>;
  ok: boolean;
  failures: string[];
  observed: {
    texts: string[];
    pressables: PressableAudit[];
    textModel: TextRow[];
    footerHeight: number | null;
    columnHeight: number | null;
    viewportHeight: number | null;
    readoutCaptionAvailablePt: number | null;
    readoutCaptionLines: number | null;
    topBarPillTextAvail: number | null;
    scrollViewCount: number;
    authState: {
      hydrated: boolean;
      signedIn: boolean;
      error: string | null;
    } | null;
    fetchCalls: string[];
    consoleErrors: string[];
    afterInteraction: string[] | null;
    durationMs: number;
    layoutModel: 'modeled' | 'n/a (degenerate numeric viewport)';
  };
  evidence?: unknown;
}

// ─── Environment control ─────────────────────────────────────────────────────

const RealDateTimeFormat = Intl.DateTimeFormat;
const realFetch = globalThis.fetch;
const realTz = nodeProcess.env['TZ'];
const realDims = {
  window: Dimensions.get('window'),
  screen: Dimensions.get('screen'),
};

function installLocale(locale: string): void {
  // The device's locale setting: Intl resolves it when no locale is passed.
  const Wrapped = function (
    this: unknown,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    return new RealDateTimeFormat(locales ?? locale, options);
  } as unknown as typeof Intl.DateTimeFormat;
  Object.setPrototypeOf(Wrapped, RealDateTimeFormat);
  Object.defineProperty(Wrapped, 'prototype', {
    value: RealDateTimeFormat.prototype,
  });
  Object.defineProperty(Wrapped, 'supportedLocalesOf', {
    value: RealDateTimeFormat.supportedLocalesOf.bind(RealDateTimeFormat),
  });
  Intl.DateTimeFormat = Wrapped;
}

function restoreEnvironment(): void {
  Intl.DateTimeFormat = RealDateTimeFormat;
  (globalThis as { fetch: unknown }).fetch = realFetch;
  if (realTz === undefined) delete nodeProcess.env['TZ'];
  else nodeProcess.env['TZ'] = realTz;
  Dimensions.set({ window: realDims.window, screen: realDims.screen });
  mockRtl.current = false;
  mockRtl.locale = 'en_US';
}

function applyScenarioEnvironment(s: Scenario): void {
  nodeProcess.env['TZ'] = s.timeZone;
  jest.setSystemTime(new Date(s.clockIso));
  installLocale(s.locale);
  mockRtl.current = s.rtl;
  mockRtl.locale = s.locale.replace('-', '_');
  const dims = {
    width: s.viewport.width,
    height: s.viewport.height,
    scale: 3,
    fontScale: s.fontScale,
  };
  Dimensions.set({ window: dims, screen: dims });
  mockSafeArea.current = {
    top: s.viewport.insetTop,
    bottom: s.viewport.insetBottom,
    left: 0,
    right: 0,
  };
  mockSafeArea.frame = {
    x: 0,
    y: 0,
    width: s.viewport.width,
    height: s.viewport.height,
  };
}

function seedPersistedWorld(s: Scenario, db: FakeLocalDb): void {
  const payload = PAYLOADS[s.payloadId] ?? '';
  switch (s.persisted) {
    case 'kv-raw':
      db.kv.set(s.persistedKey ?? 'profile', payload);
      break;
    case 'kv-json': {
      const key = s.persistedKey ?? 'profile';
      db.kv.set(key, jsonEnvelopeFor(key, payload));
      break;
    }
    case 'vault-raw':
      __keychainStore.set(SESSION_VAULT_SERVICE, {
        username: 'session',
        password: payload,
      });
      break;
    case 'vault-json':
      __keychainStore.set(SESSION_VAULT_SERVICE, {
        username: 'session',
        password: vaultEnvelopeFor(payload),
      });
      break;
    default:
      break;
  }
}

function scriptedFetch(calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push(url);
    const status = url.includes('/v1/auth/refresh') ? 401 : 404;
    return {
      ok: false,
      status,
      headers: { get: () => null },
      json: async () => ({ error: 'refused' }),
      text: async () => '{"error":"refused"}',
    } as unknown as Response;
  }) as typeof fetch;
}

function resetProcessState(): void {
  clearSyncRuntime();
  stopSessionKeeper();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    session: null,
    hydrated: false,
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
  useWalkthroughStore.setState({ visible: false, queued: false });
  __keychainStore.clear();
  mockDb.current = new FakeLocalDb();
  mockScheduler.current = new FakeScheduler();
}

async function flush(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

// ─── Layout model over the rendered tree ─────────────────────────────────────

function degenerate(s: Scenario): boolean {
  return (
    !(s.fontScale > 0 && s.fontScale < 100) ||
    !(s.viewport.width >= 200 && s.viewport.width < 10_000) ||
    !(s.viewport.height >= 200 && s.viewport.height < 100_000)
  );
}

interface LayoutReport {
  textModel: TextRow[];
  footerHeight: number;
  columnHeight: number;
  viewportHeight: number;
  readoutCaptionAvailablePt: number;
  readoutCaptionLines: number | null;
  topBarPillTextAvail: number;
  problems: string[];
}

function modelWelcomeLayout(
  root: TestRenderer.ReactTestInstance,
  s: Scenario,
  pressables: PressableAudit[],
): LayoutReport {
  const ctx: LayoutContext = {
    fontScale: s.fontScale,
    width: s.viewport.width,
    height: s.viewport.height,
    insetTop: s.viewport.insetTop,
    insetBottom: s.viewport.insetBottom,
  };
  const problems: string[] = [];
  const scrolls = root.findAllByType(ScrollView);
  const scroll = scrolls[0];
  const inScroll = (node: TestRenderer.ReactTestInstance): boolean => {
    let cur: TestRenderer.ReactTestInstance | null = node.parent;
    while (cur) {
      if (cur === scroll) return true;
      cur = cur.parent;
    }
    return false;
  };
  const contentWidth = s.viewport.width - 2 * space.lg;
  const courtInner = contentWidth - 28 - 20;
  // Top bar: BrandMark (32pt mark + 10pt gap + h3 wordmark) and the
  // PRIVATE BY DEFAULT pill (10pt horizontal padding each side) share one
  // space-between row; the pill is the only shrinkable member.
  const brandMarkWidth =
    32 + 10 + textWidth('Pickle Sensei', type.h3, s.fontScale);
  const topBarPillTextAvail = contentWidth - brandMarkWidth - 2 * 10;
  // Readout row inside the court card: the caption (flexShrink 1) shares a
  // line with the ON-DEVICE live pill (12pt padding each side, 8pt dot, 7pt
  // gap; not shrinkable) across a space.md gap.
  const livePillWidth =
    12 * 2 + 8 + 7 + textWidth('ON-DEVICE', type.micro, s.fontScale);
  const readoutCaptionAvailablePt = courtInner - space.md - livePillWidth;
  const textModel = root.findAllByType(Text).map(node => {
    const text = node.props.children;
    const isCourtCopy =
      typeof text === 'string' && /^(POSE-GUIDED|ON-DEVICE)/.test(text);
    const isCourtTitle =
      Array.isArray(text) && String(text[0]).startsWith('Automatic');
    const isReadoutCaption =
      typeof text === 'string' && text.startsWith('No shot picker');
    const isTopBarPill = text === 'PRIVATE BY DEFAULT';
    const avail = isTopBarPill
      ? topBarPillTextAvail
      : isReadoutCaption
        ? readoutCaptionAvailablePt
        : isCourtCopy || isCourtTitle
          ? courtInner
          : contentWidth;
    return modelText(node, avail, ctx, inScroll(node));
  });
  for (const row of textModel) {
    if (row.clipped) {
      problems.push(
        `clipped: ${JSON.stringify(row.text.slice(0, 40))} needs ${row.lines} lines, numberOfLines=${row.numberOfLines}`,
      );
    }
  }

  const byText = (needle: string) =>
    textModel.find(r => r.text.startsWith(needle));
  const cta = pressables.find(p => p.label === START_LABEL);
  const link = pressables.find(p => p.label === SIGN_IN_LABEL);
  const privacy = byText('Two successful');
  const footerHeight =
    space.lg +
    (cta?.modeledHeight ?? 0) +
    (link ? space.xs + link.modeledHeight : 0) +
    space.md +
    (privacy?.modeledHeight ?? 0) +
    space.sm;

  const hero = byText('See the stroke');
  const tagline = byText('A private technique coach');
  const kicker = byText('POSE-GUIDED');
  const title = byText('Automatic');
  const caption = byText('No shot picker');
  const pill = byText('ON-DEVICE');
  const pillHeight = (pill?.modeledHeight ?? 0) + 2 * 8;
  const columnHeight =
    space.sm +
    32 +
    space.xl +
    (hero?.modeledHeight ?? 0) +
    space.sm +
    (tagline?.modeledHeight ?? 0) +
    space.lg +
    28 +
    (kicker?.modeledHeight ?? 0) +
    space.sm +
    (title?.modeledHeight ?? 0) +
    5 +
    Math.max(caption?.modeledHeight ?? 0, pillHeight) +
    20;

  const viewportHeight =
    s.viewport.height - s.viewport.insetTop - s.viewport.insetBottom;
  if (footerHeight >= viewportHeight) {
    problems.push(
      `footer ${footerHeight.toFixed(0)}pt ≥ viewport ${viewportHeight}pt (pinned footer cannot fit)`,
    );
  }
  if (columnHeight > viewportHeight - footerHeight) {
    // Overflow is legal only because the column lives in a growing ScrollView.
    if (scrolls.length !== 1) {
      problems.push(
        `column overflows but ScrollView count is ${scrolls.length}`,
      );
    } else if (flat(scroll!).flex !== 1) {
      problems.push('column overflows but ScrollView is not flex:1');
    } else if (
      (scroll!.props as { contentContainerStyle?: unknown })
        .contentContainerStyle &&
      flat({
        props: {
          style: (scroll!.props as { contentContainerStyle?: unknown })
            .contentContainerStyle,
        },
      } as unknown as TestRenderer.ReactTestInstance).flexGrow !== 1
    ) {
      problems.push('ScrollView content container is not flexGrow:1');
    }
  }
  if (cta && cta.inScrollView)
    problems.push('primary CTA scrolls with the body');
  if (link && link.inScrollView)
    problems.push('sign-in link scrolls with the body');

  // A caption column narrower than its widest word forces UIKit to break
  // words glyph-by-glyph: a vertical strip of letters beside the pill.
  let readoutCaptionLines: number | null = null;
  if (caption) {
    readoutCaptionLines = caption.lines;
    const widestWord = Math.max(
      ...caption.text
        .split(/\s+/)
        .map(word => textWidth(word, type.caption, caption.scale)),
    );
    if (readoutCaptionAvailablePt < widestWord) {
      problems.push(
        `readout caption crushed: ${readoutCaptionAvailablePt.toFixed(0)}pt column for ${JSON.stringify(caption.text)} (widest word ${widestWord.toFixed(0)}pt, wraps to ${caption.lines} lines) beside a ${livePillWidth.toFixed(0)}pt pill in a ${courtInner}pt card`,
      );
    }
  }

  return {
    textModel,
    footerHeight,
    columnHeight,
    viewportHeight,
    readoutCaptionAvailablePt,
    readoutCaptionLines,
    topBarPillTextAvail,
    problems,
  };
}

// ─── One scenario ────────────────────────────────────────────────────────────

async function runScenario(s: Scenario): Promise<Row> {
  const started = performance.now();
  const consoleErrors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(a => String(a))
          .join(' ')
          .slice(0, 400),
      );
    });
  const fetchCalls: string[] = [];
  resetProcessState();
  applyScenarioEnvironment(s);
  seedPersistedWorld(s, mockDb.current);
  (globalThis as { fetch: unknown }).fetch = scriptedFetch(fetchCalls);

  const invariants: Record<string, boolean> = {};
  const failures: string[] = [];
  const fail = (key: string, why: string) => {
    invariants[key] = false;
    failures.push(`${key}: ${why}`);
  };
  const hold = (key: string) => {
    if (invariants[key] === undefined) invariants[key] = true;
  };

  const onGetStarted = jest.fn();
  const onSignIn = jest.fn();
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  let texts: string[] = [];
  let pressables: PressableAudit[] = [];
  let layout: LayoutReport | null = null;
  let afterInteraction: string[] | null = null;
  let evidence: unknown;
  let scrollViewCount = 0;
  let authState: Row['observed']['authState'] = null;

  try {
    await act(async () => {
      if (s.mount === 'app') {
        renderer = TestRenderer.create(<App />);
      } else {
        const props: {
          onGetStarted: () => void;
          onSignIn?: () => void;
        } = { onGetStarted };
        if (s.props === 'both') props.onSignIn = onSignIn;
        if (s.props === 'signin-undefined') props.onSignIn = undefined;
        if (s.props === 'getstarted-undefined') {
          (props as { onGetStarted: unknown }).onGetStarted = undefined;
          props.onSignIn = onSignIn;
        }
        renderer = TestRenderer.create(<WelcomeScreen {...props} />);
      }
    });
    if (s.mount === 'app') await flush(SPLASH_SETTLE_MS);
    else await flush(50);
    hold('noCrash');
  } catch (error) {
    fail('noCrash', `mount threw: ${String(error)}`);
  }

  if (renderer) {
    const r = renderer as TestRenderer.ReactTestRenderer;
    const root = r.root;
    texts = allText(root);
    const joined = texts.join('\n');

    if (joined.includes(ERROR_BOUNDARY_TITLE)) {
      fail('noCrash', 'RootErrorBoundary rendered');
    }
    if (
      texts.includes(START_LABEL) &&
      !/Getting things ready|Loading your account/.test(joined)
    ) {
      hold('landsOnWelcome');
    } else {
      fail(
        'landsOnWelcome',
        `Welcome CTA absent; texts=${JSON.stringify(texts.slice(0, 12))}`,
      );
    }

    const contentWidth = s.viewport.width - 2 * space.lg;
    pressables = auditPressables(
      root,
      {
        fontScale: s.fontScale,
        width: s.viewport.width,
        height: s.viewport.height,
        insetTop: s.viewport.insetTop,
        insetBottom: s.viewport.insetBottom,
      },
      contentWidth,
    );
    const expectedCount =
      s.mount === 'app' ||
      s.props === 'both' ||
      s.props === 'getstarted-undefined'
        ? 2
        : 1;
    if (pressables.length !== expectedCount) {
      fail(
        'a11yRoleLabel',
        `expected ${expectedCount} interactive elements, found ${pressables.length}: ${JSON.stringify(pressables.map(p => p.label))}`,
      );
    }
    for (const p of pressables) {
      const label = p.label ?? p.textContent;
      if (!p.role || !['button', 'link'].includes(p.role)) {
        fail(
          'a11yRoleLabel',
          `${JSON.stringify(label)} role=${String(p.role)}`,
        );
      }
      if (!label || label.trim().length === 0 || !p.accessible) {
        fail(
          'a11yRoleLabel',
          `unlabeled interactive element role=${String(p.role)}`,
        );
      }
      if (p.disabled)
        fail('a11yRoleLabel', `${JSON.stringify(label)} is disabled`);
      if (
        p.role === 'button' &&
        p.label &&
        p.textContent &&
        p.label !== p.textContent
      ) {
        fail(
          'a11yRoleLabel',
          `${JSON.stringify(label)} label differs from visible text ${JSON.stringify(p.textContent)}`,
        );
      }
    }
    hold('a11yRoleLabel');

    const degenerateViewport = degenerate(s);
    if (!degenerateViewport) {
      for (const p of pressables) {
        if (p.modeledHeight < 44 || p.modeledWidth < 44) {
          fail(
            'target44',
            `${JSON.stringify(p.label)} models ${p.modeledWidth.toFixed(0)}×${p.modeledHeight.toFixed(0)}pt`,
          );
        }
      }
      hold('target44');
      layout = modelWelcomeLayout(root, s, pressables);
      for (const problem of layout.problems) fail('layoutFit', problem);
      hold('layoutFit');
    } else {
      // Degenerate numerics: the only claim is that the render survives and
      // the explicit 44pt minimums are still declared in the styles.
      for (const p of pressables) {
        if ((p.minHeightStyle ?? 0) < 44) {
          fail(
            'target44',
            `${JSON.stringify(p.label)} declares minHeight ${String(p.minHeightStyle)}`,
          );
        }
      }
      hold('target44');
      invariants['layoutFit'] = true;
    }

    // Payload leak: the first 24 chars of the hostile string, or any run of it.
    const payload = PAYLOADS[s.payloadId] ?? '';
    const probe = payload.slice(0, 24);
    const labels = pressables
      .map(p => `${p.label ?? ''} ${p.hint ?? ''}`)
      .join('\n');
    if (
      s.persisted !== 'clean' &&
      probe.trim().length >= 3 &&
      (joined.includes(probe) || labels.includes(probe))
    ) {
      fail('noPayloadLeak', `payload ${s.payloadId} reached the Welcome tree`);
    }
    hold('noPayloadLeak');

    if (s.rtl) {
      const absolute = root
        .findAllByType(Text)
        .map(node => flat(node))
        .filter(st => st.textAlign === 'left' || st.textAlign === 'right');
      if (absolute.length > 0) {
        fail(
          'rtlSafe',
          `${absolute.length} Text nodes use absolute textAlign under RTL`,
        );
      }
    }
    hold('rtlSafe');

    const violations = copyViolations([
      ...texts,
      ...pressables.map(p => p.label ?? ''),
    ]);
    if (violations.length > 0) fail('copyPolicy', violations.join(' | '));
    hold('copyPolicy');

    // Interaction.
    try {
      const find = (label: string) =>
        root
          .findAllByType(PressableInner)
          .find(
            p =>
              (p.props as { accessibilityLabel?: string })
                .accessibilityLabel === label,
          );
      if (s.interaction !== 'none') {
        const target = find(
          s.interaction === 'start' ? START_LABEL : SIGN_IN_LABEL,
        );
        if (!target) {
          fail('interaction', `no pressable labelled for ${s.interaction}`);
        } else {
          // RN's Pressable tolerates an undefined onPress (a tap is a no-op);
          // the renderer has no gesture system, so the handler is invoked the
          // way the existing button tests do.
          const onPress = (target.props as { onPress?: () => void }).onPress;
          await act(async () => {
            onPress?.();
          });
          await flush(1_500);
          afterInteraction = allText(root);
          const after = afterInteraction.join('\n');
          if (s.mount === 'app') {
            if (after.includes(ERROR_BOUNDARY_TITLE)) {
              fail('interaction', 'RootErrorBoundary after press');
            } else if (afterInteraction.includes(START_LABEL)) {
              fail('interaction', `still on Welcome after ${s.interaction}`);
            } else if (
              s.interaction === 'signin' &&
              !/Apple|Google|Sign in|sign in/i.test(after)
            ) {
              fail(
                'interaction',
                `sign-in did not reach the sign-in screen: ${JSON.stringify(afterInteraction.slice(0, 8))}`,
              );
            } else if (
              s.interaction === 'start' &&
              root.findAllByType(PressableInner).length === 0
            ) {
              fail(
                'interaction',
                'onboarding rendered no interactive elements',
              );
            }
          } else {
            const expectStart =
              s.interaction === 'start' && s.props !== 'getstarted-undefined'
                ? 1
                : 0;
            const expectSign = s.interaction === 'signin' ? 1 : 0;
            if (onGetStarted.mock.calls.length !== expectStart) {
              fail(
                'interaction',
                `onGetStarted called ${onGetStarted.mock.calls.length}×, expected ${expectStart}`,
              );
            }
            if (onSignIn.mock.calls.length !== expectSign) {
              fail(
                'interaction',
                `onSignIn called ${onSignIn.mock.calls.length}×, expected ${expectSign}`,
              );
            }
          }
        }
      }
      hold('interaction');
    } catch (error) {
      fail('interaction', `press threw: ${String(error)}`);
    }

    scrollViewCount = root.findAllByType(ScrollView).length;
    const auth = useAuthStore.getState();
    authState = {
      hydrated: auth.hydrated,
      signedIn: auth.session !== null,
      error: auth.error?.code ?? null,
    };
    if (failures.length > 0) evidence = compactTree(r.toJSON());
  }

  const allowedFetch =
    s.persisted === 'vault-json' ? /\/v1\/auth\/refresh$/ : /$^/;
  const stray = fetchCalls.filter(url => !allowedFetch.test(url));
  if (stray.length > 0)
    fail('noStrayFetch', `unexpected network: ${JSON.stringify(stray)}`);
  hold('noStrayFetch');

  try {
    await act(async () => {
      (renderer as TestRenderer.ReactTestRenderer | null)?.unmount();
    });
    await flush(100);
  } catch (error) {
    fail('noCrash', `unmount threw: ${String(error)}`);
  }
  errorSpy.mockRestore();
  if (consoleErrors.length > 0) {
    fail(
      'noCrash',
      `console.error ×${consoleErrors.length}: ${consoleErrors[0]}`,
    );
  }
  hold('noCrash');
  restoreEnvironment();

  const ok = failures.length === 0;
  return {
    seed: s.seed,
    label: scenarioLabel(s),
    scenario: s,
    invariants,
    ok,
    failures,
    observed: {
      texts,
      pressables,
      textModel: layout?.textModel ?? [],
      footerHeight: layout?.footerHeight ?? null,
      columnHeight: layout?.columnHeight ?? null,
      viewportHeight: layout?.viewportHeight ?? null,
      readoutCaptionAvailablePt: layout?.readoutCaptionAvailablePt ?? null,
      readoutCaptionLines: layout?.readoutCaptionLines ?? null,
      topBarPillTextAvail: layout?.topBarPillTextAvail ?? null,
      scrollViewCount,
      authState,
      fetchCalls,
      consoleErrors,
      afterInteraction,
      durationMs: Math.round(performance.now() - started),
      layoutModel: degenerate(s)
        ? 'n/a (degenerate numeric viewport)'
        : 'modeled',
    },
    ...(evidence ? { evidence } : {}),
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

const rows: Row[] = [];

beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(() => {
  restoreEnvironment();
  jest.useRealTimers();
  const dir = artifactDir();
  const summary = {
    unit: 'scr-welcomescreen',
    lens: 'boundary-i18n-a11y',
    baseSeed: BASE_SEED,
    randomIter: RANDOM_ITER,
    seedFilter: SEED_FILTER,
    executed: rows.length,
    passed: rows.filter(r => r.ok).length,
    failed: rows
      .filter(r => !r.ok)
      .map(r => ({ seed: r.seed, failures: r.failures })),
    byFamily: Object.fromEntries(
      ['grid', 'locale', 'timezone', 'random'].map(f => [
        f,
        rows.filter(r => r.scenario.family === f).length,
      ]),
    ),
    byMount: {
      app: rows.filter(r => r.scenario.mount === 'app').length,
      direct: rows.filter(r => r.scenario.mount === 'direct').length,
    },
    invariantHolds: Object.fromEntries(
      [
        'noCrash',
        'landsOnWelcome',
        'noPayloadLeak',
        'a11yRoleLabel',
        'target44',
        'layoutFit',
        'rtlSafe',
        'copyPolicy',
        'interaction',
        'noStrayFetch',
      ].map(k => [
        k,
        {
          held: rows.filter(r => r.invariants[k] === true).length,
          broken: rows.filter(r => r.invariants[k] === false).length,
        },
      ]),
    ),
    locales: [...new Set(rows.map(r => r.scenario.locale))].sort(),
    timeZones: [...new Set(rows.map(r => r.scenario.timeZone))].sort(),
    fontScales: [...new Set(rows.map(r => r.scenario.fontScale))].sort(
      (a, b) => a - b,
    ),
    widths: [...new Set(rows.map(r => r.scenario.viewport.width))].sort(
      (a, b) => a - b,
    ),
    payloads: [...new Set(rows.map(r => r.scenario.payloadId))].sort(),
    persisted: Object.fromEntries(
      ['clean', 'kv-raw', 'kv-json', 'vault-raw', 'vault-json'].map(k => [
        k,
        rows.filter(r => r.scenario.persisted === k).length,
      ]),
    ),
    totalMs: rows.reduce((sum, r) => sum + r.observed.durationMs, 0),
  };
  fs.writeFileSync(
    path.join(dir, 'rows.json'),
    JSON.stringify(
      rows.map(r => ({
        seed: r.seed,
        ok: r.ok,
        label: r.label,
        invariants: r.invariants,
        failures: r.failures,
        scenario: r.scenario,
        observed: r.observed,
      })),
      null,
      1,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'failures.json'),
    JSON.stringify(
      rows.filter(r => !r.ok),
      null,
      1,
    ) + '\n',
  );
  // One rendered-tree exhibit per corner cell for the report, pass or fail.
  const exhibits = rows
    .filter(r => r.scenario.family === 'grid')
    .map(r => ({
      seed: r.seed,
      label: r.label,
      pressables: r.observed.pressables,
      footerHeight: r.observed.footerHeight,
      columnHeight: r.observed.columnHeight,
      viewportHeight: r.observed.viewportHeight,
      readoutCaptionAvailablePt: r.observed.readoutCaptionAvailablePt,
      readoutCaptionLines: r.observed.readoutCaptionLines,
      topBarPillTextAvail: r.observed.topBarPillTextAvail,
      textModel: r.observed.textModel,
    }));
  fs.writeFileSync(
    path.join(dir, 'grid-exhibits.json'),
    JSON.stringify(exhibits, null, 1) + '\n',
  );
});

describe(`WelcomeScreen boundary/i18n/a11y stress (${SCENARIOS.length} rows)`, () => {
  test.each(SCENARIOS.map(s => [scenarioLabel(s), s] as const))(
    '%s',
    async (_label, scenario) => {
      let row: Row;
      try {
        row = await runScenario(scenario);
      } catch (error) {
        restoreEnvironment();
        row = {
          seed: scenario.seed,
          label: scenarioLabel(scenario),
          scenario,
          invariants: { harness: false },
          ok: false,
          failures: [`harness threw: ${String(error)}`],
          observed: {
            texts: [],
            pressables: [],
            textModel: [],
            footerHeight: null,
            columnHeight: null,
            viewportHeight: null,
            readoutCaptionAvailablePt: null,
            readoutCaptionLines: null,
            topBarPillTextAvail: null,
            scrollViewCount: 0,
            authState: null,
            fetchCalls: [],
            consoleErrors: [],
            afterInteraction: null,
            durationMs: 0,
            layoutModel: 'n/a (degenerate numeric viewport)',
          },
        };
      }
      rows.push(row);
      if (!row.ok) {
        throw new Error(
          `seed ${row.seed} BROKEN\n  ${row.failures.join('\n  ')}\n  replay: STRESS_SEED=${row.seed} npx jest --ci __tests__/stress/welcomeScreenBoundaryI18nA11y.stress.test.tsx`,
        );
      }
    },
  );

  test('campaign executed every planned row', () => {
    expect(rows.length).toBe(SCENARIOS.length);
    // The corner grid alone is 29 rows; a STRESS_SEED replay may be smaller.
    expect(rows.length).toBeGreaterThanOrEqual(
      SEED_FILTER.length > 0 ? SEED_FILTER.length : 29,
    );
  });
});
