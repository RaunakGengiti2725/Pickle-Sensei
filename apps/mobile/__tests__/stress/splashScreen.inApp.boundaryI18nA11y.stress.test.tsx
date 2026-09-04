/**
 * STRESS — scr-splashscreen / lens boundary-i18n-a11y (app plane).
 *
 * Mounts the REAL `<App />` — SafeAreaProvider → QueryClientProvider →
 * StatusBar → RootErrorBoundary → Gate — so the splash is driven by the real
 * `authStore.hydrate()` / `appStore.hydrate()` readiness, sits over the real
 * `LoadingState` → `WelcomeScreen` underlay, and is unmounted by the real
 * `handleSplashFinished`. Only process edges are faked: SQLite (FakeLocalDb),
 * Keychain (repo auto-mock, empty vault ⇒ signed-out launch),
 * `react-native-webview` (a host View), `react-native-video` (repo auto-mock),
 * `Dimensions` / `I18nManager` constants, `Intl` locale and the process time
 * zone. No network is reached: the vault is empty so nothing refreshes.
 *
 * Campaign (STRESS_ITER extra seeded rows, default 0):
 *   E  3 font scales × 3 widths × {skip, watchdog, playback-end} × RM{off,on}
 *      × SQLite latency {0, 400 ms} (108 rows; the slow half presses Skip /
 *      ends playback BEFORE the Gate is ready)
 *   F  12 locales × {skip} at the 375-pt phone (12 rows)
 *   G  seeded mixes of the above (STRESS_ITER rows, default 0)
 *
 * Invariants (each is a row.invariants key):
 *   noCrash            no throw, no React error log, RootErrorBoundary silent
 *   splashOnTop        while mounted the splash is the LAST child of the Gate
 *                      root (rendered above LoadingState/Welcome/overlays)
 *   underlayBeforeExit the Gate's real `ready` flipped (Welcome painted under
 *                      the splash) BEFORE the splash started its exit
 *   splashInteractiveA11y every interactive host INSIDE the splash has a
 *                      label, a role and a modelled ≥ 44 pt box
 *   underlayInteractiveA11y …and so does every interactive host under it
 *   skipLabelAndRole   Skip is "Skip intro" / button whenever shown
 *   skipFitsZone       modelled Skip height ≤ 15 % zone at this viewport/scale
 *   pointerOwnership   splash pointerEvents auto → none, never back
 *   handoffGatedOnReady the exit starts at max(ready, finish) ± one poll
 *                      (slow SQLite ⇒ Skip pressed BEFORE ready must wait)
 *   exitLength         exit lasts EXIT_MS (0 + a frame under reduced motion)
 *   statusBarOnTop     dark-content is the top StatusBar entry while the splash
 *                      is mounted (even after dark Welcome mounts under it);
 *                      Welcome's light-content wins once the splash is gone
 *   splashRemoved      after the exit the `splash-screen` host is gone and
 *                      Welcome is the visible screen (handoff happened once)
 *   noReappear         a further 8.6 s never brings the splash back
 *
 * Artifacts: artifacts/stress-splashscreen/app.{rows,summary,trees}.json
 */
import React from 'react';
import {
  AccessibilityInfo,
  Dimensions,
  I18nManager,
  StatusBar,
} from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { FakeLocalDb } from '../../xc-harness/lifecycle-persistence/fakeLocalDb';
import { nodeProcess } from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  LOCALES,
  PRIMARY_FONT_SCALES,
  TIMEZONES,
  VIEWPORTS,
  isRtlLocale,
  iterationBudget,
  makePrng,
  pick,
  seedFilter,
  type Locale,
  type Viewport,
} from '../../xc-harness/stress-splash/env';
import {
  auditAccessibility,
  byTestId,
  dumpHostTree,
  finishRow,
  innermostByTestId,
  modelBox,
  realNow,
  summarizeRows,
  writeJsonArtifact,
  type StressRow,
  type TreeDump,
} from '../../xc-harness/stress-splash/tree';

// ─── Native edges ────────────────────────────────────────────────────────────

/** SQLite with a per-statement latency so slow launches leave the Gate not-ready. */
const mockDb = { current: new FakeLocalDb(), latencyMs: 0 };
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    const inner = mockDb.current.handle();
    return {
      execute: async (sql: string, params: unknown[] = []) => {
        if (mockDb.latencyMs > 0) {
          await new Promise<void>(resolve =>
            setTimeout(resolve, mockDb.latencyMs),
          );
        }
        return inner.execute(sql, params);
      },
      close: () => inner.close(),
    };
  },
}));
jest.mock('react-native-webview', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return { WebView: RN.View, default: RN.View };
});
// The native RNCSafeAreaProvider renders nothing until the platform delivers
// insets; the repo's App-rendering suites fake it the same way.
jest.mock('react-native-safe-area-context', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const Passthrough = (props: { children?: React.ReactNode }) =>
    R.createElement(RN.View, null, props.children);
  return {
    SafeAreaProvider: Passthrough,
    SafeAreaView: Passthrough,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 375, height: 667 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

import App from '../../App';
import {
  EXIT_MS,
  SKIP_AFTER_S,
  WATCHDOG_MS,
} from '../../src/screens/SplashScreen';
import { useAppStore } from '../../src/state/appStore';
import { useAuthStore } from '../../src/auth/authStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import { clearApiSession } from '../../src/account/apiSession';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import * as Keychain from 'react-native-keychain';

// The auto-mock (__mocks__/react-native-keychain.ts) exposes its vault.
const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

type StatusBarStack = {
  _propsStack: { barStyle: { value: string; animated: boolean } | null }[];
};
const statusBarStack = StatusBar as unknown as StatusBarStack;
const SKIP_LABEL = 'Skip intro';
const FRAME_SLACK_MS = 50;
/** Real hydrate() needs a few macrotask turns; the unit plane needs none. */
const HYDRATE_MS = 300;

const rows: StressRow[] = [];
const trees: Record<string, TreeDump[]> = {};

type Finish = 'skip' | 'watchdog' | 'playback-end';
const FINISHES: readonly Finish[] = ['skip', 'watchdog', 'playback-end'];

interface AppScenario {
  seed: number;
  fontScale: number;
  viewport: Viewport;
  locale: Locale;
  reducedMotion: boolean;
  finish: Finish;
  /** Per-SQLite-statement latency: 0 = instant launch, >0 = slow device. */
  dbLatencyMs: number;
}

/**
 * Per-statement SQLite latency. The signed-out hydrate runs ~5 statements in
 * sequence, so 400 ms lands the Gate's `ready` at ≈ 2 s: AFTER the Skip press /
 * playback end at 1.3 s, BEFORE the 8 s watchdog.
 */
const DB_LATENCIES = [0, 400] as const;
const POLL_MS = 100;
const HANDOFF_DEADLINE_MS = 20_000;

function scenarioFromSeed(seed: number): AppScenario {
  const rng = makePrng(seed);
  return {
    seed,
    fontScale: pick(rng, PRIMARY_FONT_SCALES),
    viewport: pick(rng, VIEWPORTS),
    locale: pick(rng, LOCALES),
    reducedMotion: rng() < 0.5,
    finish: pick(rng, FINISHES),
    dbLatencyMs: pick(rng, DB_LATENCIES),
  };
}

// ─── Environment plumbing ────────────────────────────────────────────────────

function setViewport(viewport: Viewport, fontScale: number): void {
  const dims = {
    width: viewport.width,
    height: viewport.height,
    scale: viewport.scale,
    fontScale,
  };
  Dimensions.set({ window: dims, screen: dims });
}

function setLocale(locale: Locale): () => void {
  const i18n = I18nManager as unknown as { isRTL: boolean };
  const previousRtl = i18n.isRTL;
  i18n.isRTL = isRtlLocale(locale);
  const proto = Intl.DateTimeFormat.prototype;
  const original = proto.resolvedOptions;
  proto.resolvedOptions = function patched(this: Intl.DateTimeFormat) {
    return { ...original.call(this), locale };
  };
  return () => {
    i18n.isRTL = previousRtl;
    proto.resolvedOptions = original;
  };
}

function emitReducedMotion(value: boolean): void {
  const calls = (AccessibilityInfo.addEventListener as unknown as jest.Mock)
    .mock.calls as [string, (value: boolean) => void][];
  for (const [event, listener] of calls) {
    if (event === 'reduceMotionChanged') listener(value);
  }
}

let clockMs = 0;
async function advance(ms: number): Promise<void> {
  const target = clockMs + ms;
  if (clockMs < WATCHDOG_MS && target > WATCHDOG_MS) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(WATCHDOG_MS - clockMs);
    });
    clockMs = WATCHDOG_MS;
  }
  await act(async () => {
    await jest.advanceTimersByTimeAsync(target - clockMs);
  });
  clockMs = target;
}

/** A cold process: only Keychain (empty) + SQLite (fresh) would survive. */
function resetProcessState(): void {
  __keychainStore.clear();
  mockDb.current = new FakeLocalDb();
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
}

// ─── Observation ─────────────────────────────────────────────────────────────

interface Snapshot {
  phase: string;
  splashCount: number;
  splashIsLastChild: boolean | null;
  pointerEvents: unknown;
  welcomePresent: boolean;
  loadingPresent: boolean;
  errorBoundaryShown: boolean;
  skipPresent: boolean;
  skipLabel: unknown;
  skipRole: unknown;
  skipHeight: number | null;
  splashA11y: { unlabeled: string[]; unroled: string[]; under44: string[] };
  underlayA11y: {
    interactive: number;
    unlabeled: string[];
    unroled: string[];
    under44: string[];
  };
  statusTop: string | undefined;
}

function hasText(root: ReactTestInstance, text: string): boolean {
  return (
    root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.children !== undefined &&
        String(node.props.children) === text,
    ).length > 0
  );
}

function snapshot(
  root: ReactTestInstance,
  phase: string,
  ctx: { fontScale: number; width: number; height: number },
): Snapshot {
  const splashes = byTestId(root, 'splash-screen');
  const splash = innermostByTestId(root, 'splash-screen');
  const skip = innermostByTestId(root, 'splash-skip');
  const whole = auditAccessibility(root, ctx);
  const splashAudit = splash
    ? auditAccessibility(splash, ctx)
    : { interactive: 0, unlabeled: [], unroled: [], under44: [] };
  const inSplash = (id: string) =>
    splash !== null &&
    (splashAudit.unlabeled.includes(id) ||
      splashAudit.unroled.includes(id) ||
      splashAudit.under44.includes(id));
  let splashIsLastChild: boolean | null = null;
  if (splash) {
    // Walk up to the host child of the Gate root (the View with flex:1).
    let node: ReactTestInstance | null = splash;
    while (node?.parent && typeof node.parent.type !== 'string') {
      node = node.parent;
    }
    const parent = node?.parent ?? null;
    if (parent) {
      const hostKids = parent.children.filter(
        (child): child is ReactTestInstance => typeof child !== 'string',
      );
      splashIsLastChild = hostKids[hostKids.length - 1] === node;
    }
  }
  const stack = statusBarStack._propsStack;
  return {
    phase,
    splashCount: splashes.length,
    splashIsLastChild,
    pointerEvents: splash?.props.pointerEvents,
    welcomePresent: byTestId(root, 'welcome-court-story').length > 0,
    loadingPresent: hasText(root, 'Getting things ready'),
    errorBoundaryShown: hasText(root, 'Something went wrong'),
    skipPresent: skip !== null,
    skipLabel: skip?.props.accessibilityLabel,
    skipRole: skip?.props.accessibilityRole,
    skipHeight: skip ? modelBox(skip, ctx).height : null,
    splashA11y: {
      unlabeled: splashAudit.unlabeled,
      unroled: splashAudit.unroled,
      under44: splashAudit.under44,
    },
    underlayA11y: {
      interactive: whole.interactive - splashAudit.interactive,
      unlabeled: whole.unlabeled.filter(id => !inSplash(id)),
      unroled: whole.unroled.filter(id => !inSplash(id)),
      under44: whole.under44.filter(id => !inSplash(id)),
    },
    statusTop: stack.length
      ? stack[stack.length - 1]?.barStyle?.value
      : undefined,
  };
}

// ─── Scenario execution ──────────────────────────────────────────────────────

async function runApp(
  suite: string,
  name: string,
  s: AppScenario,
): Promise<StressRow> {
  const started = realNow();
  const ctx = {
    fontScale: s.fontScale,
    width: s.viewport.width,
    height: s.viewport.height,
  };
  clockMs = 0;
  resetProcessState();
  mockDb.latencyMs = s.dbLatencyMs;
  setViewport(s.viewport, s.fontScale);
  const restoreLocale = setLocale(s.locale);
  jest.setSystemTime(new Date(TIMEZONES[0]!.startIso));
  const errors: string[] = [];
  const consoleError = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' ').slice(0, 300));
    });
  const snaps: Snapshot[] = [];
  let crash: string | null = null;
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  let exitStartedAt: number | null = null;
  let readyAt: number | null = null;
  let removedAt: number | null = null;
  let finishAt: number | null = null;
  /** Cheap 100 ms trace of the handoff window (no a11y audit per tick). */
  const trace: {
    t: number;
    splash: number;
    pointer: unknown;
    welcome: boolean;
    statusTop: string | undefined;
  }[] = [];
  const observe = (splashCount: number, pointer: unknown, welcome: boolean) => {
    if (welcome && readyAt === null) readyAt = clockMs;
    if (pointer === 'none' && exitStartedAt === null) exitStartedAt = clockMs;
    if (splashCount === 0 && removedAt === null) removedAt = clockMs;
  };
  const take = (phase: string) => {
    if (!renderer) return;
    const snap = snapshot(renderer.root, phase, ctx);
    snaps.push(snap);
    observe(snap.splashCount, snap.pointerEvents, snap.welcomePresent);
  };
  const advanceTicking = async (ms: number) => {
    const target = clockMs + ms;
    while (clockMs < target) {
      await advance(Math.min(POLL_MS, target - clockMs));
      tick();
    }
  };
  const tick = () => {
    if (!renderer) return;
    const root = renderer.root;
    const splash = innermostByTestId(root, 'splash-screen');
    const stack = statusBarStack._propsStack;
    const point = {
      t: clockMs,
      splash: byTestId(root, 'splash-screen').length,
      pointer: splash?.props.pointerEvents,
      welcome: byTestId(root, 'welcome-court-story').length > 0,
      statusTop: stack.length
        ? stack[stack.length - 1]?.barStyle?.value
        : undefined,
    };
    trace.push(point);
    observe(point.splash, point.pointer, point.welcome);
  };
  try {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(App));
    });
    await act(async () => {
      emitReducedMotion(s.reducedMotion);
    });
    take('mount');
    if (!trees[`${suite}:mount:${s.viewport.name}:${s.fontScale}`]) {
      trees[`${suite}:mount:${s.viewport.name}:${s.fontScale}`] = dumpHostTree(
        renderer!.root,
      );
    }
    await advanceTicking(HYDRATE_MS);
    take('hydrated');
    const player = innermostByTestId(renderer!.root, 'splash-video');
    if (!player) throw new Error('splash-video host missing after hydrate');
    const progress = async (currentTime: number) => {
      await act(async () => {
        player.props.onProgress({
          currentTime,
          playableDuration: 0,
          seekableDuration: 0,
        });
      });
    };
    await progress(0.4);
    take('progress-0.4');
    await advanceTicking(700);
    await progress(SKIP_AFTER_S + 0.2);
    take('progress-1.2');
    if (
      !trees[`${suite}:skip-visible:${s.viewport.name}:${s.fontScale}`] &&
      snaps[snaps.length - 1]?.skipPresent
    ) {
      trees[`${suite}:skip-visible:${s.viewport.name}:${s.fontScale}`] =
        dumpHostTree(renderer!.root);
    }
    await advanceTicking(300);
    switch (s.finish) {
      case 'skip': {
        const skip = innermostByTestId(renderer!.root, 'splash-skip');
        if (!skip) throw new Error('Skip missing after 1.2 s of progress');
        await act(async () => {
          skip.props.onClick?.();
        });
        break;
      }
      case 'playback-end':
        await act(async () => player.props.onEnd());
        break;
      case 'watchdog':
        await advanceTicking(WATCHDOG_MS - clockMs);
        break;
    }
    finishAt = clockMs;
    take(`after-${s.finish}`);
    // Poll until the splash unmounts (or the deadline): a slow launch keeps the
    // Gate not-ready past the finish trigger, so the exit waits for `ready`.
    let exitingDumped = false;
    while (removedAt === null && clockMs < finishAt + HANDOFF_DEADLINE_MS) {
      await advanceTicking(POLL_MS);
      if (!exitingDumped && exitStartedAt !== null && removedAt === null) {
        exitingDumped = true;
        take('exiting');
        if (!trees[`${suite}:exiting:${s.viewport.name}`]) {
          trees[`${suite}:exiting:${s.viewport.name}`] = dumpHostTree(
            renderer!.root,
          );
        }
      }
    }
    take('handed-off');
    await advance(WATCHDOG_MS + EXIT_MS + FRAME_SLACK_MS);
    take('long-after');
  } catch (error) {
    crash =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  } finally {
    try {
      await act(async () => {
        renderer?.unmount();
      });
    } catch (error) {
      crash ??= error instanceof Error ? error.message : String(error);
    }
    consoleError.mockRestore();
    restoreLocale();
    emitReducedMotion(false);
  }
  const reactErrors = errors.filter(
    line => !line.includes('not wrapped in act'),
  );
  const zoneHeight = 0.15 * s.viewport.height;
  const skipHeights = snaps
    .map(x => x.skipHeight)
    .filter((h): h is number => h !== null);
  const skipMaxHeight = skipHeights.reduce((m, h) => Math.max(m, h), 0);
  const mounted = snaps.filter(x => x.splashCount > 0);
  const pointerSequence = mounted.map(x => x.pointerEvents);
  const firstNone = pointerSequence.indexOf('none');
  const handedOff = snaps.find(x => x.phase === 'handed-off');
  const longAfter = snaps.find(x => x.phase === 'long-after');
  const exitDuration = s.reducedMotion ? 0 : EXIT_MS;
  // Timing is observed on a POLL_MS grid; reduced motion still completes on
  // the next animation frame, hence the frame slack.
  const timingSlack = POLL_MS + FRAME_SLACK_MS;
  const gateOpenAt =
    readyAt !== null && finishAt !== null ? Math.max(readyAt, finishAt) : null;
  const exitStartOnTime =
    gateOpenAt !== null &&
    exitStartedAt !== null &&
    exitStartedAt >= gateOpenAt - POLL_MS &&
    exitStartedAt <= gateOpenAt + timingSlack;
  const exitLengthOnTime =
    exitStartedAt !== null &&
    removedAt !== null &&
    removedAt - exitStartedAt >= exitDuration - POLL_MS &&
    removedAt - exitStartedAt <= exitDuration + timingSlack;
  const traceStatusOk = trace.every(x =>
    x.splash > 0
      ? x.statusTop === 'dark-content'
      : x.statusTop === 'light-content',
  );
  const tracePointer = trace.filter(x => x.splash > 0).map(x => x.pointer);
  const traceFirstNone = tracePointer.indexOf('none');
  const tracePointerOk = tracePointer.every(
    (value, index) =>
      value ===
      (traceFirstNone !== -1 && index >= traceFirstNone ? 'none' : 'auto'),
  );

  const invariants: Record<string, boolean> = {
    noCrash:
      crash === null &&
      reactErrors.length === 0 &&
      snaps.every(x => !x.errorBoundaryShown),
    splashOnTop: mounted.every(x => x.splashIsLastChild === true),
    underlayBeforeExit:
      readyAt !== null && exitStartedAt !== null && readyAt <= exitStartedAt,
    splashInteractiveA11y: mounted.every(
      x =>
        x.splashA11y.unlabeled.length === 0 &&
        x.splashA11y.unroled.length === 0 &&
        x.splashA11y.under44.length === 0,
    ),
    underlayInteractiveA11y: snaps.every(
      x =>
        x.underlayA11y.unlabeled.length === 0 &&
        x.underlayA11y.unroled.length === 0 &&
        x.underlayA11y.under44.length === 0,
    ),
    skipLabelAndRole: snaps.every(
      x =>
        !x.skipPresent ||
        (x.skipLabel === SKIP_LABEL && x.skipRole === 'button'),
    ),
    skipFitsZone: skipHeights.length === 0 || skipMaxHeight <= zoneHeight,
    pointerOwnership:
      pointerSequence.every(
        (value, index) =>
          value === (firstNone !== -1 && index >= firstNone ? 'none' : 'auto'),
      ) && tracePointerOk,
    // The exit starts only once BOTH the Gate is ready and playback is over /
    // Skip was pressed, and lasts EXIT_MS (0 under reduced motion).
    handoffGatedOnReady: exitStartOnTime,
    exitLength: exitLengthOnTime,
    // Over the light video the bar must read dark-content even after the dark
    // Welcome mounts underneath (the splash re-pushes on every `ready` flip);
    // once the splash is gone Welcome's own light-content entry must win.
    statusBarOnTop:
      snaps.every(x =>
        x.splashCount > 0
          ? x.statusTop === 'dark-content'
          : x.statusTop === 'light-content',
      ) && traceStatusOk,
    splashRemoved:
      handedOff !== undefined &&
      handedOff.splashCount === 0 &&
      handedOff.welcomePresent &&
      removedAt !== null,
    noReappear:
      longAfter !== undefined &&
      longAfter.splashCount === 0 &&
      longAfter.welcomePresent,
  };
  const row = finishRow({
    suite,
    scenario: name,
    seed: s.seed,
    inputs: {
      fontScale: s.fontScale,
      viewport: s.viewport.name,
      locale: s.locale,
      rtl: isRtlLocale(s.locale),
      reducedMotion: s.reducedMotion,
      finish: s.finish,
      dbLatencyMs: s.dbLatencyMs,
    },
    observed: {
      loadingSeen: snaps.some(x => x.loadingPresent),
      crash,
      reactErrors,
      readyAtMs: readyAt,
      finishAtMs: finishAt,
      gateOpenAtMs: gateOpenAt,
      exitStartedAtMs: exitStartedAt,
      removedAtMs: removedAt,
      exitLengthMs:
        exitStartedAt !== null && removedAt !== null
          ? removedAt - exitStartedAt
          : null,
      traceTicks: trace.length,
      /** `<ms>:<splash count><W=welcome|-><N=pointer none|A=auto>` per tick */
      trace: trace.map(
        x =>
          `${x.t}:${x.splash}${x.welcome ? 'W' : '-'}${
            x.pointer === 'none' ? 'N' : 'A'
          }`,
      ),
      skipMaxHeight: Math.round(skipMaxHeight * 100) / 100,
      zoneHeight,
      zoneHeadroomPt: Math.round((zoneHeight - skipMaxHeight) * 100) / 100,
      underlayInteractiveMax: snaps.reduce(
        (m, x) => Math.max(m, x.underlayA11y.interactive),
        0,
      ),
      phases: snaps.map(x => ({
        phase: x.phase,
        splash: x.splashCount,
        top: x.splashIsLastChild,
        pointer: x.pointerEvents,
        welcome: x.welcomePresent,
        loading: x.loadingPresent,
        skip: x.skipPresent,
        statusTop: x.statusTop,
        underlayA11y: x.underlayA11y,
        splashA11y: x.splashA11y,
      })),
      statusTops: Array.from(new Set(snaps.map(x => x.statusTop))),
    },
    invariants,
    durationMs: realNow() - started,
  });
  if (!row.ok && renderer) {
    trees[`FAIL:${suite}:${name}:${s.seed}`] = [
      { type: '#phases', text: JSON.stringify(row.observed.phases) },
    ];
  }
  rows.push(row);
  return row;
}

// ─── Suites ──────────────────────────────────────────────────────────────────

beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(() => {
  jest.useRealTimers();
  const summary = summarizeRows(rows);
  const rowsFile = writeJsonArtifact('app.rows.json', rows);
  const summaryFile = writeJsonArtifact('app.summary.json', summary);
  const treesFile = writeJsonArtifact('app.trees.json', trees);
  console.log(
    `[stress:splash:app] rows=${rows.length} failed=${String(summary.failed)} → ${rowsFile}, ${summaryFile}, ${treesFile}`,
  );
});

const only = seedFilter(nodeProcess.env);

describe('E · real <App/>: 3 font scales × 3 widths × 3 finishes × reduce motion', () => {
  const cells: AppScenario[] = [];
  let seed = 70_000;
  for (const fontScale of PRIMARY_FONT_SCALES) {
    for (const viewport of VIEWPORTS) {
      for (const finish of FINISHES) {
        for (const reducedMotion of [false, true]) {
          for (const dbLatencyMs of DB_LATENCIES) {
            seed += 1;
            cells.push({
              seed,
              fontScale,
              viewport,
              locale: 'en-IN',
              reducedMotion,
              finish,
              dbLatencyMs,
            });
          }
        }
      }
    }
  }
  for (const cell of cells) {
    if (only !== null && only !== cell.seed) continue;
    const name = `${cell.viewport.name}@${cell.fontScale}·${cell.finish}·rm=${String(cell.reducedMotion)}·db=${cell.dbLatencyMs}ms`;
    test(name, async () => {
      const row = await runApp('E-app-matrix', name, cell);
      expect(row.failed).toEqual([]);
    });
  }
});

describe('F · real <App/>: 12 locales (RTL included) at 375 pt', () => {
  let seed = 71_000;
  for (const locale of LOCALES) {
    seed += 1;
    if (only !== null && only !== seed) continue;
    const cell: AppScenario = {
      seed,
      fontScale: 1,
      viewport: VIEWPORTS[1]!,
      locale,
      reducedMotion: false,
      finish: 'skip',
      dbLatencyMs: 0,
    };
    test(locale, async () => {
      const row = await runApp('F-app-locales', locale, cell);
      expect(row.failed).toEqual([]);
    });
  }
});

describe('G · real <App/>: seeded (STRESS_ITER, default 0)', () => {
  const budget = iterationBudget(nodeProcess.env, 'STRESS_ITER', 0);
  const seeds =
    only !== null
      ? only >= 72_000
        ? [only]
        : []
      : Array.from({ length: budget }, (_, i) => 72_000 + i);
  for (const seed of seeds) {
    test(`seed ${seed}`, async () => {
      const s = scenarioFromSeed(seed);
      const row = await runApp('G-app-seeded', `seed-${seed}`, s);
      expect(row.failed).toEqual([]);
    });
  }
});
