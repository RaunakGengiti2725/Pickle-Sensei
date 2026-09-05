/**
 * STRESS — FormReviewScreen under dependency failure injection.
 *
 * The REAL screen is mounted inside a REAL `NavigationContainer` + native
 * stack (the same registration shape RootNavigator uses: a Result route
 * pushes `FormReview`, and the screen's "Re-analyze" navigates to
 * `Analyze`), over a REAL SQLite database (`node:sqlite`) that the
 * production `getDb()` migrates and the production repository queries.
 * Only native modules are doubled: `@op-engineering/op-sqlite` (backed by
 * node:sqlite, with per-statement fault injection), the `PickleVideoCapture`
 * bridge (sidecar file reads), safe-area insets and react-native-svg.
 *
 * Every fault case below is `<dependency>.<mode>`; each runs `STRESS_ITER`
 * seeds (default 1). Replay one row of the results table with
 *   STRESS_CASE=<dependency.mode> STRESS_SEED=<seed> npx jest formReviewScreen.failureInjection
 * and measure a flake rate with `STRESS_REPEAT=10` (same seed, 10 runs).
 *
 * Invariants asserted on EVERY seed (a failing test = a reproduced finding):
 *   no-crash            the screen never throws into the error boundary
 *   no-infinite-spinner after 60s of fake time the loading state is gone
 *   recovery-control    a Close / Try again / Back control is visible and
 *                       pressing it pops the stack back to Result
 *   honest-signal       the final state matches what the evidence supports
 *                       (missing analysis → "Review unavailable"; missing
 *                       pose → no skeleton drawn + the honest caption)
 *   no-garbage-text     no "undefined" / "NaN" / "null" / "[object Object]"
 *   no-garbage-geometry every drawn skeleton line has finite endpoints
 *                       inside the stage (|px| ≤ STAGE_LIMIT_PX)
 *   no-unhandled        no unhandled rejection / console.error escaped
 *   read-only-db        the screen issues no INSERT/UPDATE/DELETE and every
 *                       table is byte-identical afterwards
 *   no-network          `fetch` is never called
 *   no-camera           no PickleVideoCapture method other than
 *                       readTextFile is invoked
 *
 * Dependencies the screen does not reach (RevenueCat, Keychain, Google
 * sign-in, WebView, notify-kit, react-native-video) are pinned by throwing
 * module factories: pulling any of them into the screen's graph fails the
 * whole suite at import.
 */
import '../../testing/stress/nativeCaptureMock';
import React from 'react';
import { Text, View } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import {
  NavigationContainer,
  useRoute,
  type NavigationContainerRef,
  type RouteProp,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ShotAnalysis } from '@pickle/shared-types';
import { FormReviewScreen } from '../../src/screens/FormReviewScreen';
import type { RootStackParams } from '../../src/navigation/params';
import { getDb } from '../../src/data/db';
import { setActiveDataOwner } from '../../src/data/accountScope';
import {
  clearTryAgainHandoff,
  peekTryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';
import {
  createOpSqliteDouble,
  type StatementFault,
  type StatementFaultMode,
} from '../../testing/stress/opSqliteDouble';
import {
  nativeCaptureCalls,
  readTextFileCalls,
  setReadTextFile,
} from '../../testing/stress/nativeCaptureMock';
import {
  ANALYSIS_ID,
  CAPTURE_ID,
  SESSION_ID,
  SIBLING_ANALYSIS_ID,
  capturePayload,
  insertCapture,
  insertRecord,
  insertShot,
  makeAnalysis,
  makeWireSequence,
  sidecarRefFor,
  type CaptureRowOverrides,
  type SidecarRef,
  type WireSequence,
} from '../../testing/stress/formReviewFixtures';
import {
  appendStressRow,
  caseSeeds,
  caseSelected,
  pick,
  randomInt,
  seededRandom,
  shuffle,
  type Verdict,
} from '../../testing/stress/stressEvidence';

const mockSqlite = createOpSqliteDouble();
jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.open(options),
}));

jest.mock('react-native-safe-area-context', () => {
  const mock = require('react-native-safe-area-context/jest/mock');
  return mock.default ?? mock;
});

jest.mock('react-native-svg', () => {
  const ReactLib = require('react');
  const RN = require('react-native');
  const named = (name: string) => {
    // Geometry props (x1/y1/x2/y2, cx/cy, d) stay on the host view so the
    // harness can assert what was actually drawn.
    const Mock = (props: { children?: React.ReactNode }) =>
      ReactLib.createElement(
        RN.View,
        { ...props, testID: `svg-${name}` },
        props.children,
      );
    Mock.displayName = `Svg${name}`;
    return Mock;
  };
  return {
    __esModule: true,
    default: named('Svg'),
    Svg: named('Svg'),
    Circle: named('Circle'),
    Defs: named('Defs'),
    G: named('G'),
    Line: named('Line'),
    Path: named('Path'),
    Polygon: named('Polygon'),
    Polyline: named('Polyline'),
    RadialGradient: named('RadialGradient'),
    LinearGradient: named('LinearGradient'),
    Rect: named('Rect'),
    Stop: named('Stop'),
  };
});

// Dependencies this screen must never reach. A throwing factory turns any
// future import into a loud suite failure instead of a silent pass.
jest.mock('react-native-purchases', () => {
  throw new Error(
    'stress: FormReviewScreen graph reached react-native-purchases',
  );
});
jest.mock('react-native-keychain', () => {
  throw new Error(
    'stress: FormReviewScreen graph reached react-native-keychain',
  );
});
jest.mock('@react-native-google-signin/google-signin', () => {
  throw new Error('stress: FormReviewScreen graph reached google-signin');
});
jest.mock('react-native-webview', () => {
  throw new Error(
    'stress: FormReviewScreen graph reached react-native-webview',
  );
});
jest.mock('react-native-notify-kit', () => {
  throw new Error(
    'stress: FormReviewScreen graph reached react-native-notify-kit',
  );
});
jest.mock('react-native-video', () => {
  throw new Error('stress: FormReviewScreen graph reached react-native-video');
});

const SUITE = 'formReviewScreen.failureInjection';
const SIXTY_SECONDS_MS = 60_000;
const LOADING_CAPTION = 'Preparing your form review…';
const MISSING_TITLE = 'Review unavailable';
const CAPTION_NO_CLIP_NO_POSE =
  'No clip file or recorded pose is stored for this stroke on this device.';
const CAPTION_NO_POSE =
  'No verified pose sequence is stored for this clip, so the replay shows the video without an exoskeleton.';
const CAPTION_CLIP_GONE =
  'The clip file is gone from this device; the measured pose is shown instead.';

// ─── Real navigator host ─────────────────────────────────────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();

function ResultStub() {
  return <View testID="result-stub" />;
}

function AnalyzeStub() {
  const route = useRoute<RouteProp<RootStackParams, 'Analyze'>>();
  return <Text testID="analyze-stub">{route.params?.source ?? 'none'}</Text>;
}

class Boundary extends React.Component<
  { onError: (error: unknown) => void; children: React.ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };
  static getDerivedStateFromError() {
    return { crashed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.crashed ? (
      <Text testID="boundary-fallback">Something went wrong</Text>
    ) : (
      this.props.children
    );
  }
}

function Host(props: {
  navRef: React.RefObject<NavigationContainerRef<RootStackParams> | null>;
  onError: (error: unknown) => void;
  withAnalyzeRoute: boolean;
}) {
  return (
    <SafeAreaProvider>
      <Boundary onError={props.onError}>
        <NavigationContainer ref={props.navRef}>
          <Stack.Navigator
            initialRouteName="Result"
            screenOptions={{ headerShown: false }}
          >
            <Stack.Screen
              name="Result"
              component={ResultStub}
              initialParams={{ analysisId: ANALYSIS_ID }}
            />
            <Stack.Screen name="FormReview" component={FormReviewScreen} />
            {props.withAnalyzeRoute ? (
              <Stack.Screen name="Analyze" component={AnalyzeStub} />
            ) : null}
          </Stack.Navigator>
        </NavigationContainer>
      </Boundary>
    </SafeAreaProvider>
  );
}

// ─── Tree inspection ─────────────────────────────────────────────────────────

function textOf(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (child: unknown): void => {
    if (child === null || child === undefined || typeof child === 'boolean')
      return;
    if (typeof child === 'string' || typeof child === 'number') {
      parts.push(String(child));
      return;
    }
    if (Array.isArray(child)) child.forEach(walk);
  };
  walk(node.props.children);
  return parts.join('');
}

function allTexts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(textOf)
    .filter(t => t !== '');
}

function labels(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(n => typeof n.props.accessibilityLabel === 'string')
    .map(n => String(n.props.accessibilityLabel));
}

function findByTestId(
  renderer: ReactTestRenderer,
  testID: string,
): ReactTestInstance | null {
  const hits = renderer.root.findAll(n => n.props.testID === testID);
  return hits[0] ?? null;
}

function pressable(
  renderer: ReactTestRenderer,
  predicate: (node: ReactTestInstance) => boolean,
): ReactTestInstance | null {
  const hits = renderer.root.findAll(
    n => typeof n.props.onPress === 'function' && predicate(n),
  );
  return hits[0] ?? null;
}

const GARBAGE = /undefined|NaN|\[object Object\]|Infinity/;

function garbageTexts(renderer: ReactTestRenderer): string[] {
  return [...allTexts(renderer), ...labels(renderer)].filter(
    t => GARBAGE.test(t) || t.trim() === 'null',
  );
}

type ScreenState = 'loading' | 'missing' | 'ready' | 'crashed' | 'absent';

function screenState(renderer: ReactTestRenderer): ScreenState {
  if (findByTestId(renderer, 'boundary-fallback')) return 'crashed';
  if (findByTestId(renderer, 'form-review-screen')) return 'ready';
  const texts = allTexts(renderer);
  if (texts.includes(MISSING_TITLE)) return 'missing';
  if (texts.includes(LOADING_CAPTION)) return 'loading';
  return 'absent';
}

function skeletonLines(renderer: ReactTestRenderer): number {
  const overlay = findByTestId(renderer, 'form-review-overlay');
  if (!overlay) return 0;
  return overlay.findAll(n => n.props.testID === 'svg-Line').length;
}

/** Any pose stage this screen can lay out is far smaller than this. */
const STAGE_LIMIT_PX = 10_000;
/** Portrait iPhone stage the player would measure via onLayout. */
const STAGE_LAYOUT = { x: 0, y: 0, width: 390, height: 520 };

/** The test renderer never fires onLayout; deliver a realistic stage size. */
async function layoutStage(renderer: ReactTestRenderer): Promise<void> {
  const stage = findByTestId(renderer, 'form-review-stage');
  const onLayout = stage?.props['onLayout'] as
    | ((event: { nativeEvent: { layout: typeof STAGE_LAYOUT } }) => void)
    | undefined;
  if (!onLayout) return;
  await act(async () => {
    onLayout({ nativeEvent: { layout: STAGE_LAYOUT } });
  });
}

/** Skeleton line endpoints that are not finite or are absurdly off-stage. */
function offStageLineEndpoints(renderer: ReactTestRenderer): string[] {
  const overlay = findByTestId(renderer, 'form-review-overlay');
  if (!overlay) return [];
  const bad: string[] = [];
  for (const line of overlay.findAll(n => n.props.testID === 'svg-Line')) {
    for (const key of ['x1', 'y1', 'x2', 'y2']) {
      const value = Number(line.props[key]);
      if (!Number.isFinite(value) || Math.abs(value) > STAGE_LIMIT_PX) {
        bad.push(`${key}=${String(line.props[key])}`);
      }
    }
  }
  return bad;
}

function stopCount(renderer: ReactTestRenderer): number | null {
  const card = findByTestId(renderer, 'form-review-stop-card');
  const label = card ? String(card.props.accessibilityLabel ?? '') : '';
  const match = /stop \d+ of (\d+)/.exec(label);
  return match ? Number(match[1]) : null;
}

// ─── Scenario plumbing ───────────────────────────────────────────────────────

interface SeedOptions {
  analysis?: ShotAnalysis | null;
  shotPayload?: string;
  record?: 'honest' | 'absent' | string;
  capture?: 'honest' | 'absent' | CaptureRowOverrides;
  sidecar?: SidecarRef | null;
  /** What the native file read returns for the sidecar uri. */
  sidecarFile?: string | (() => unknown) | 'unavailable';
  sibling?: boolean;
}

interface Expectation {
  state: ScreenState | 'missing-or-ready';
  /** Whether a skeleton may be drawn in the ready state. */
  pose: 'none' | 'shown' | 'any';
  /** The honest caption the stage must show (ready state). */
  caption?: 'noClipNoPose' | 'noPose' | 'clipGone' | 'none' | 'any';
}

interface Ctx {
  renderer: ReactTestRenderer;
  navRef: React.RefObject<NavigationContainerRef<RootStackParams> | null>;
  random: () => number;
  /** Advance fake time in act, flushing microtasks. */
  advance: (ms: number) => Promise<void>;
  flush: () => Promise<void>;
  observed: Record<string, unknown>;
  broken: string[];
}

interface Plan {
  inputs: Record<string, unknown>;
  seed?: SeedOptions;
  faults?: StatementFault[];
  openFault?: { open?: boolean; migration?: boolean };
  params?: unknown;
  withAnalyzeRoute?: boolean;
  expect: Expectation;
  /** Interactions after the first render, before the 60s advance. */
  drive?: (ctx: Ctx) => Promise<void>;
  /** Extra checks after the 60s advance, before recovery. */
  after?: (ctx: Ctx) => Promise<void>;
  /** Skip the standard recovery press (the drive already left the screen). */
  skipRecovery?: boolean;
}

const honestSequence = makeWireSequence();
const honestSidecarJson = JSON.stringify(honestSequence);
const honestSidecar = sidecarRefFor(
  honestSidecarJson,
  honestSequence.frames.length,
);

function seedDatabase(options: SeedOptions): void {
  const raw = mockSqlite.raw();
  const analysis =
    options.analysis === undefined ? makeAnalysis() : options.analysis;
  if (analysis) insertShot(raw, analysis, options.shotPayload);
  if (options.sibling) {
    insertShot(
      raw,
      makeAnalysis({
        id: SIBLING_ANALYSIS_ID,
        phases: [],
        checkpoints: [],
        priorityFix: null,
        capturedAtIso: '2026-09-01T10:05:00.000Z',
      }),
    );
  }
  const record = options.record ?? 'honest';
  if (record === 'honest') insertRecord(raw, ANALYSIS_ID, CAPTURE_ID);
  else if (record !== 'absent')
    insertRecord(raw, ANALYSIS_ID, CAPTURE_ID, record);
  const sidecar =
    options.sidecar === undefined ? honestSidecar : options.sidecar;
  const capture = options.capture ?? 'honest';
  if (capture === 'honest') insertCapture(raw, sidecar);
  else if (capture !== 'absent') insertCapture(raw, sidecar, capture);
  const file = options.sidecarFile ?? honestSidecarJson;
  if (file === 'unavailable') setReadTextFile(undefined);
  else if (typeof file === 'string')
    setReadTextFile(() => Promise.resolve(file));
  else setReadTextFile(file);
}

const mounted: ReactTestRenderer[] = [];
const consoleErrors: string[] = [];
const unhandled: string[] = [];
const fetchCalls: unknown[][] = [];
let realConsoleError: typeof console.error;
let realConsoleWarn: typeof console.warn;

// Inside a Jest test `process` is a per-environment copy (jest-util
// createProcessObject), so `process.on('unhandledRejection')` never fires.
// Node emits the event on the main-context process, reachable through the
// real `vm` core module. jest-circus listens there too and still fails the
// test; this listener only makes the rejection part of the recorded row.
const realProcess = (require('vm') as typeof import('vm')).runInThisContext(
  'process',
) as NodeJS.Process;
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason instanceof Error ? reason.message : String(reason));
};

// Node only reports unhandled rejections on a real macrotask boundary; fake
// timers never reach one, so every flush yields on the real event loop.
const realSetImmediate = setImmediate;
const realNow = Date.now;
const realTick = () =>
  new Promise<void>(resolve => {
    realSetImmediate(resolve);
  });

beforeAll(() => {
  setActiveDataOwner('device-guest');
  getDb();
  realConsoleError = console.error;
  realConsoleWarn = console.warn;
  (globalThis as { fetch: unknown }).fetch = (...args: unknown[]) => {
    fetchCalls.push(args);
    throw new Error('stress: FormReviewScreen must not call fetch');
  };
});

afterAll(() => {
  console.error = realConsoleError;
  console.warn = realConsoleWarn;
});

beforeEach(() => {
  jest.useFakeTimers();
  mockSqlite.clearFaults();
  mockSqlite.setOpenFault({});
  mockSqlite.reset();
  mockSqlite.clearLog();
  mockSqlite.pending = 0;
  consoleErrors.length = 0;
  unhandled.length = 0;
  fetchCalls.length = 0;
  nativeCaptureCalls.length = 0;
  readTextFileCalls.length = 0;
  clearTryAgainHandoff();
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(a => String(a)).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    const text = args.map(a => String(a)).join(' ');
    // React Navigation dev-only nudges are not the screen's failures.
    if (/non-serializable|Linking/.test(text)) return;
    consoleErrors.push(`warn: ${text}`);
  };
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    try {
      await act(async () => {
        renderer.unmount();
      });
    } catch {
      // A crashed tree may already be gone.
    }
  }
  mockSqlite.clearFaults();
  mockSqlite.setOpenFault({});
  jest.clearAllTimers();
  jest.useRealTimers();
  // The production singleton may have been closed by an open-fault case.
  getDb();
});

const WRITE_SQL =
  /^\s*(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|BEGIN|COMMIT)/i;

async function runScenario(
  caseName: string,
  seed: number,
  plan: Plan,
): Promise<void> {
  const started = realNow();
  const random = seededRandom(seed);
  const observed: Record<string, unknown> = {};
  const broken: string[] = [];
  const crashes: string[] = [];
  realProcess.on('unhandledRejection', onUnhandled);

  seedDatabase(plan.seed ?? {});
  const before = JSON.stringify(mockSqlite.snapshot());
  mockSqlite.clearLog();
  mockSqlite.setStatementFaults(plan.faults ?? []);
  mockSqlite.setOpenFault(plan.openFault ?? {});
  if (plan.openFault) getDb().close();

  const navRef =
    React.createRef<NavigationContainerRef<RootStackParams> | null>();
  let renderer!: ReactTestRenderer;
  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await realTick();
    });
  };
  const advance = async (ms: number) => {
    let remaining = ms;
    while (remaining > 0) {
      const step = Math.min(remaining, 2_000);
      await act(async () => {
        jest.advanceTimersByTime(step);
        await Promise.resolve();
      });
      remaining -= step;
    }
  };

  await act(async () => {
    renderer = TestRenderer.create(
      <Host
        navRef={navRef}
        onError={error =>
          crashes.push(error instanceof Error ? error.message : String(error))
        }
        withAnalyzeRoute={plan.withAnalyzeRoute ?? true}
      />,
    );
  });
  mounted.push(renderer);
  await flush();

  const params = 'params' in plan ? plan.params : { analysisId: ANALYSIS_ID };
  await act(async () => {
    (
      navRef.current as unknown as {
        navigate: (name: string, params?: unknown) => void;
      } | null
    )?.navigate('FormReview', params);
  });
  await flush();
  observed['stateAfterMount'] = screenState(renderer);

  const ctx: Ctx = {
    renderer,
    navRef,
    random,
    advance,
    flush,
    observed,
    broken,
  };
  if (plan.drive) await plan.drive(ctx);

  await advance(SIXTY_SECONDS_MS);
  await flush();
  await layoutStage(renderer);

  const state = screenState(renderer);
  observed['stateAfter60s'] = state;
  observed['texts'] = allTexts(renderer).slice(0, 40);
  observed['skeletonLines'] = skeletonLines(renderer);
  observed['stops'] = stopCount(renderer);
  observed['readTextFileCalls'] = readTextFileCalls.length;
  observed['sqlStatements'] = mockSqlite.log.length;
  observed['pendingSql'] = mockSqlite.pending;

  // no-crash
  if (crashes.length > 0 || state === 'crashed') {
    observed['crash'] = crashes;
    broken.push(`no-crash: ${crashes.join(' | ')}`);
  }
  // no-infinite-spinner
  if (state === 'loading') {
    broken.push(
      'no-infinite-spinner: still "Preparing your form review…" after 60s',
    );
  }
  // honest-signal
  if (!plan.skipRecovery) {
    const wanted = plan.expect.state;
    const stateOk =
      wanted === 'missing-or-ready'
        ? state === 'missing' || state === 'ready'
        : state === wanted;
    if (!stateOk && state !== 'loading' && state !== 'crashed') {
      broken.push(`honest-signal: state ${state}, expected ${wanted}`);
    }
    if (state === 'ready') {
      const lines = skeletonLines(renderer);
      if (plan.expect.pose === 'none' && lines > 0) {
        broken.push(
          `honest-signal: skeleton drawn (${lines} lines) with no verified pose`,
        );
      }
      if (plan.expect.pose === 'shown' && lines === 0) {
        broken.push('honest-signal: verified pose present but not drawn');
      }
      const texts = allTexts(renderer);
      const captionMap: Record<string, string> = {
        noClipNoPose: CAPTION_NO_CLIP_NO_POSE,
        noPose: CAPTION_NO_POSE,
        clipGone: CAPTION_CLIP_GONE,
      };
      const caption = plan.expect.caption ?? 'any';
      if (caption === 'none') {
        const stray = texts.find(
          t =>
            t.startsWith(CAPTION_NO_CLIP_NO_POSE) ||
            t === CAPTION_NO_POSE ||
            t === CAPTION_CLIP_GONE,
        );
        if (stray) broken.push(`honest-signal: unexpected caption "${stray}"`);
      } else if (caption !== 'any') {
        const want = captionMap[caption]!;
        if (!texts.some(t => t.startsWith(want))) {
          broken.push(`honest-signal: caption "${want}" not shown`);
        }
      }
    }
  }
  // no-garbage-text
  const garbage = garbageTexts(renderer);
  if (garbage.length > 0) {
    observed['garbage'] = garbage;
    broken.push(`no-garbage-text: ${garbage.slice(0, 3).join(' | ')}`);
  }
  // no-garbage-geometry
  const offStage = offStageLineEndpoints(renderer);
  if (offStage.length > 0) {
    observed['offStageEndpoints'] = offStage.slice(0, 8);
    broken.push(
      `no-garbage-geometry: ${offStage.length} skeleton endpoint(s) off-stage, e.g. ${offStage[0]}`,
    );
  }

  if (plan.after) await plan.after(ctx);

  // recovery-control: a visible way out that really pops the stack.
  if (!plan.skipRecovery && state !== 'crashed' && state !== 'absent') {
    const control =
      pressable(renderer, n => n.props.testID === 'form-review-back') ??
      pressable(renderer, n => n.props.accessibilityLabel === 'Try again') ??
      pressable(renderer, n => n.props.accessibilityLabel === 'Close');
    observed['recoveryControl'] = control
      ? String(control.props.testID ?? control.props.accessibilityLabel)
      : null;
    if (!control) {
      broken.push('recovery-control: no Back / Try again / Close control');
    } else {
      await act(async () => {
        control.props.onPress();
      });
      await flush();
      await advance(1_000);
      const root = navRef.current?.getRootState();
      const top = root?.routes[root.index]?.name;
      observed['routeAfterRecovery'] = top;
      if (top !== 'Result') {
        broken.push(
          `recovery-control: stack top is ${String(top)}, not Result`,
        );
      }
      if (findByTestId(renderer, 'form-review-screen')) {
        broken.push('recovery-control: form review still mounted after back');
      }
    }
  }

  // Late settlements after the screen is gone must stay silent.
  await advance(SIXTY_SECONDS_MS * 2);
  await flush();

  // no-unhandled
  realProcess.off('unhandledRejection', onUnhandled);
  if (unhandled.length > 0) {
    observed['unhandledRejections'] = unhandled.slice();
    broken.push(`no-unhandled: ${unhandled.join(' | ')}`);
  }
  if (consoleErrors.length > 0) {
    observed['consoleErrors'] = consoleErrors.slice(0, 5);
    broken.push(
      `no-unhandled: console.error ${consoleErrors[0]!.slice(0, 160)}`,
    );
  }
  // read-only-db
  const writes = mockSqlite.log.filter(entry => WRITE_SQL.test(entry.sql));
  if (writes.length > 0) {
    observed['writes'] = writes.map(w => w.sql.slice(0, 60));
    broken.push(`read-only-db: ${writes.length} write statement(s)`);
  }
  const after = JSON.stringify(mockSqlite.snapshot());
  if (after !== before) broken.push('read-only-db: persisted rows changed');
  // no-network / no-camera
  if (fetchCalls.length > 0)
    broken.push(`no-network: fetch called ${fetchCalls.length}x`);
  if (nativeCaptureCalls.length > 0) {
    broken.push(`no-camera: ${nativeCaptureCalls.join(',')}`);
  }

  const verdict: Verdict = broken.length === 0 ? 'HELD' : 'BROKEN';
  appendStressRow({
    suite: SUITE,
    case: caseName,
    seed,
    inputs: plan.inputs,
    observed,
    broken,
    verdict,
    durationMs: realNow() - started,
    atIso: new Date(realNow()).toISOString(),
  });
  expect(broken).toEqual([]);
}

// ─── Fault vocabulary ────────────────────────────────────────────────────────

const STATEMENTS = {
  shot: /FROM local_shot\s+WHERE owner_key = \? AND id = \?/,
  record: /FROM local_analysis_record/,
  capture: /FROM local_capture/,
  attempts:
    /FROM local_shot\s+WHERE owner_key = \? AND source = 'real'\s+ORDER BY captured_at DESC LIMIT \?/,
} as const;
type StatementName = keyof typeof STATEMENTS;

type TimingMode = 'throw' | 'reject' | 'never' | 'slow' | 'timeout';
const TIMING_MODES: TimingMode[] = [
  'throw',
  'reject',
  'never',
  'slow',
  'timeout',
];

function timingFault(
  random: () => number,
  statement: StatementName,
  mode: TimingMode,
): { fault: StatementFault; inputs: Record<string, unknown>; hangs: boolean } {
  const delay =
    mode === 'slow'
      ? randomInt(random, 200, 55_000)
      : mode === 'timeout'
        ? randomInt(random, 61_000, 240_000)
        : undefined;
  const sqlMode: StatementFaultMode =
    mode === 'slow' || mode === 'timeout' ? 'slow' : mode;
  return {
    fault: {
      match: STATEMENTS[statement],
      mode: sqlMode,
      ...(delay !== undefined ? { delayMs: delay } : {}),
    },
    inputs: { statement, mode, delayMs: delay ?? null },
    hangs: mode === 'never' || mode === 'timeout',
  };
}

/** What the screen can honestly show once `statement` failed outright. */
function expectationAfterFailure(statement: StatementName): Expectation {
  switch (statement) {
    case 'shot':
      // record.result is null in the seeded record → no analysis at all.
      return { state: 'missing', pose: 'none' };
    case 'record':
      // No record → no capture lookup → no clip, no sidecar.
      return { state: 'ready', pose: 'none', caption: 'noClipNoPose' };
    case 'capture':
      return { state: 'ready', pose: 'none', caption: 'noClipNoPose' };
    case 'attempts':
      // Attempts are not rendered by this screen: full review.
      return { state: 'ready', pose: 'shown', caption: 'none' };
  }
}

const HONEST: Expectation = { state: 'ready', pose: 'shown', caption: 'none' };
const NO_POSE: Expectation = {
  state: 'ready',
  pose: 'none',
  caption: 'noPose',
};

function mutateSequence(
  random: () => number,
  kind: string,
  sequence: WireSequence,
): { wire: unknown; frameCount: number; note: string } {
  const frames = sequence.frames.map(f => ({
    ...f,
    l: f.l.map(l => ({ ...l })),
  }));
  switch (kind) {
    case 'wrongSchema': {
      const which = pick(random, [
        'schemaVersion',
        'format',
        'coordinateSystem',
        'poseModelVersion',
      ]);
      const wire: Record<string, unknown> = { ...sequence, frames };
      wire[which] =
        which === 'schemaVersion'
          ? randomInt(random, 2, 9)
          : which === 'poseModelVersion'
            ? ''
            : `stress-${which}`;
      return { wire, frameCount: frames.length, note: `${which} invalid` };
    }
    case 'partialFrames': {
      const keep = Math.max(
        1,
        Math.floor(frames.length * (randomInt(random, 5, 70) / 100)),
      );
      const kept = shuffle(random, frames)
        .slice(0, keep)
        .sort((a, b) => a.t - b.t);
      return {
        wire: { ...sequence, frames: kept },
        frameCount: random() < 0.5 ? frames.length : kept.length,
        note: `${keep}/${frames.length} frames kept`,
      };
    }
    case 'emptyFrames':
      return {
        wire: { ...sequence, frames: [] },
        frameCount: 0,
        note: 'no frames',
      };
    case 'badCoords': {
      const poison = pick(random, ['NaN', 1e308, -1e308, -5, 7, 'x', null]);
      const hit = randomInt(random, 1, 20);
      for (let i = 0; i < hit; i += 1) {
        const frame = pick(random, frames);
        const mark = pick(random, frame.l) as Record<string, unknown>;
        mark[pick(random, ['x', 'y', 'v'])] = poison;
      }
      return {
        wire: { ...sequence, frames },
        frameCount: frames.length,
        note: `${hit} landmarks poisoned with ${String(poison)}`,
      };
    }
    case 'nonMonotonic': {
      const times = shuffle(
        random,
        frames.map(f => f.t),
      );
      frames.forEach((f, i) => {
        f.t = times[i]!;
      });
      return {
        wire: { ...sequence, frames },
        frameCount: frames.length,
        note: 'timestamps shuffled',
      };
    }
    case 'missingJoints': {
      const dropEvery = randomInt(random, 1, 4);
      frames.forEach((f, i) => {
        if (i % dropEvery === 0) {
          const survivors = randomInt(random, 0, 3);
          f.l = shuffle(random, f.l).slice(0, survivors);
        }
      });
      return {
        wire: { ...sequence, frames },
        frameCount: frames.length,
        note: `joints dropped every ${dropEvery} frames`,
      };
    }
    case 'badTimestamps': {
      const poison = pick(random, ['NaN', -100, 1e15, 'later', null]);
      const frame = pick(random, frames) as Record<string, unknown>;
      frame['t'] = poison;
      return {
        wire: { ...sequence, frames },
        frameCount: frames.length,
        note: `one t = ${String(poison)}`,
      };
    }
    case 'outOfRangeShown': {
      // Finite but outside the normalized [0,1] image: poison a joint of the
      // first frame, the one the replay shows at stop 1 (t = 0).
      const poison = pick(random, [-1e308, 1e308, -5, 7, 1.5, -0.2, 3e9]);
      const first = frames[0]!;
      const joint = pick(random, [
        'head',
        'left_shoulder',
        'right_shoulder',
        'left_hip',
        'right_hip',
        'left_wrist',
        'right_wrist',
      ]);
      const mark = first.l.find(l => l.n === joint) as
        Record<string, unknown> | undefined;
      if (mark) mark[pick(random, ['x', 'y'])] = poison;
      return {
        wire: { ...sequence, frames },
        frameCount: frames.length,
        note: `frame 0 ${joint} = ${String(poison)}`,
      };
    }
    case 'badVideo': {
      const video = { ...sequence.video } as Record<string, unknown>;
      video[pick(random, ['w', 'h', 'fps'])] = pick(random, [
        0,
        -1,
        'NaN',
        null,
      ]);
      return {
        wire: { ...sequence, video, frames },
        frameCount: frames.length,
        note: 'video dims invalid',
      };
    }
    case 'huge': {
      const copies = randomInt(random, 20, 60);
      const big: WireSequence['frames'] = [];
      for (let c = 0; c < copies; c += 1) {
        for (const f of frames)
          big.push({ ...f, i: big.length, t: c * 3240 + f.t });
      }
      return {
        wire: { ...sequence, frames: big },
        frameCount: big.length,
        note: `${big.length} frames`,
      };
    }
    default:
      throw new Error(`unknown mutation ${kind}`);
  }
}

function sidecarContentPlan(random: () => number, kind: string): Plan {
  const mutated = mutateSequence(random, kind, honestSequence);
  const json = JSON.stringify(mutated.wire);
  const ref = sidecarRefFor(json, mutated.frameCount);
  // Semantically wrong but byte-verified content: the canonical parser must
  // reject it (→ no skeleton) or render it without garbage.
  // badCoords: a non-numeric/NaN landmark must be rejected, a finite one is
  // parseable — either way no-garbage-geometry decides what was drawn.
  const expectation: Expectation =
    kind === 'partialFrames' ||
    kind === 'missingJoints' ||
    kind === 'huge' ||
    kind === 'badCoords' ||
    kind === 'outOfRangeShown'
      ? { state: 'ready', pose: 'any', caption: 'any' }
      : NO_POSE;
  return {
    inputs: { mutation: kind, note: mutated.note, bytes: json.length },
    seed: { sidecar: ref, sidecarFile: json },
    expect: expectation,
  };
}

function corruptAnalysisPayload(random: () => number): {
  payload: string;
  note: string;
  state: Expectation['state'];
} {
  const kind = pick(random, [
    'notJson',
    'jsonNull',
    'jsonNumber',
    'jsonString',
    'jsonArray',
    'empty',
    'partial',
  ]);
  if (kind === 'partial') {
    const analysis = makeAnalysis() as unknown as Record<string, unknown>;
    const mutations = [
      () => delete analysis['phases'],
      () => (analysis['phases'] = null),
      () => (analysis['phases'] = 'x'),
      () =>
        (analysis['phases'] = [
          null,
          { key: 'contact' },
          { key: 'ready', startMs: 'a', endMs: 'b' },
        ]),
      () => delete analysis['checkpoints'],
      () => (analysis['checkpoints'] = {}),
      () =>
        (analysis['checkpoints'] = [
          null,
          5,
          { key: 'contact_position' },
          { key: 'nope', score: 'x' },
        ]),
      () => delete analysis['timestamps'],
      () =>
        (analysis['timestamps'] = { startMs: 5000, contactMs: 100, endMs: -1 }),
      () => (analysis['timestamps'] = { startMs: 'a' }),
      () => (analysis['shotType'] = 'unknown_shot'),
      () => delete analysis['shotType'],
      () => (analysis['shotType'] = 42),
      () => (analysis['handedness'] = 'both'),
      () => (analysis['priorityFix'] = {}),
      () => (analysis['priorityFix'] = { checkpoint: 'nope' }),
      () => (analysis['overallScore'] = 'high'),
      () => (analysis['measurements'] = 'x'),
      () => (analysis['sessionId'] = 42),
      () => (analysis['id'] = 'someone-else'),
      () => (analysis['versionVector'] = null),
      () => (analysis['capturedAtIso'] = 'not-a-date'),
      () => (analysis['resultKind'] = 'low_confidence'),
    ];
    const count = randomInt(random, 1, 3);
    const chosen = shuffle(
      random,
      mutations.map((m, i) => i),
    ).slice(0, count);
    for (const index of chosen) mutations[index]!();
    return {
      payload: JSON.stringify(analysis),
      note: `partial mutations ${chosen.join(',')}`,
      state: 'missing-or-ready',
    };
  }
  const payload =
    kind === 'notJson'
      ? '{"id": "stress'
      : kind === 'jsonNull'
        ? 'null'
        : kind === 'jsonNumber'
          ? '42'
          : kind === 'jsonString'
            ? '"analysis"'
            : kind === 'jsonArray'
              ? '[]'
              : '';
  return { payload, note: kind, state: 'missing-or-ready' };
}

// ─── Cases ───────────────────────────────────────────────────────────────────

const CASES: Record<string, (random: () => number) => Plan> = {};

// SQLite — engine level
CASES['sqlite.open.throw'] = () => ({
  inputs: { fault: 'op-sqlite open() throws' },
  openFault: { open: true },
  expect: { state: 'missing', pose: 'none' },
});
CASES['sqlite.open.migrationThrow'] = () => ({
  inputs: { fault: 'first migration statement throws' },
  openFault: { migration: true },
  expect: { state: 'missing', pose: 'none' },
});

// SQLite — per statement timing faults
for (const statement of Object.keys(STATEMENTS) as StatementName[]) {
  for (const mode of TIMING_MODES) {
    CASES[`sqlite.${statement}.${mode}`] = random => {
      const { fault, inputs, hangs } = timingFault(random, statement, mode);
      return {
        inputs,
        faults: [fault],
        expect: hangs
          ? { state: 'loading', pose: 'none' }
          : mode === 'slow'
            ? statement === 'shot'
              ? { state: 'ready', pose: 'shown', caption: 'none' }
              : { state: 'ready', pose: 'shown', caption: 'none' }
            : expectationAfterFailure(statement),
      };
    };
  }
}

// SQLite — malformed / partial rows
CASES['sqlite.shot.malformed'] = random => {
  const corrupt = corruptAnalysisPayload(random);
  return {
    inputs: { payload: corrupt.note, preview: corrupt.payload.slice(0, 80) },
    seed: { shotPayload: corrupt.payload },
    expect: { state: corrupt.state, pose: 'any', caption: 'any' },
  };
};
CASES['sqlite.shot.rowShape'] = random => {
  const shape = pick(random, [
    'noPayloadColumn',
    'payloadNull',
    'payloadNumber',
    'twoRows',
    'emptyObjectRow',
  ]);
  return {
    inputs: { shape },
    faults: [
      {
        match: STATEMENTS.shot,
        mode: 'rows',
        rows: honest => {
          switch (shape) {
            case 'noPayloadColumn':
              return honest.map(row => ({ id: row['id'] }));
            case 'payloadNull':
              return honest.map(row => ({ ...row, payload: null }));
            case 'payloadNumber':
              return honest.map(row => ({ ...row, payload: 12345 }));
            case 'twoRows':
              return [...honest, ...honest];
            default:
              return [{}];
          }
        },
      },
    ],
    expect: { state: 'missing-or-ready', pose: 'any', caption: 'any' },
  };
};
CASES['sqlite.record.malformed'] = random => {
  const kind = pick(random, [
    'notJson',
    'jsonNull',
    'jsonArray',
    'jsonString',
    'empty',
  ]);
  const record =
    kind === 'notJson'
      ? '{"id":'
      : kind === 'jsonNull'
        ? 'null'
        : kind === 'jsonArray'
          ? '[]'
          : kind === 'jsonString'
            ? '"rec"'
            : '';
  return {
    inputs: { record: kind },
    seed: { record },
    expect: { state: 'ready', pose: 'none', caption: 'noClipNoPose' },
  };
};
CASES['sqlite.record.partial'] = random => {
  const kind = pick(random, [
    'captureIdNumber',
    'captureIdMissing',
    'captureIdEmpty',
    'captureIdUnknown',
    'captureIdObject',
    'resultGarbage',
  ]);
  const base: Record<string, unknown> = {
    id: ANALYSIS_ID,
    captureId: CAPTURE_ID,
    strokeIntent: null,
    result: null,
  };
  if (kind === 'captureIdNumber') base['captureId'] = 42;
  if (kind === 'captureIdMissing') delete base['captureId'];
  if (kind === 'captureIdEmpty') base['captureId'] = '';
  if (kind === 'captureIdUnknown') base['captureId'] = 'no-such-capture';
  if (kind === 'captureIdObject') base['captureId'] = { id: CAPTURE_ID };
  if (kind === 'resultGarbage')
    base['result'] = { shotType: 42, checkpoints: 'x' };
  return {
    inputs: { record: kind },
    seed: { record: JSON.stringify(base) },
    expect:
      kind === 'resultGarbage'
        ? { state: 'ready', pose: 'shown', caption: 'none' }
        : { state: 'ready', pose: 'none', caption: 'noClipNoPose' },
  };
};
CASES['sqlite.capture.malformed'] = random => {
  const kind = pick(random, [
    'notJson',
    'emptyObject',
    'mismatch',
    'badSidecarRef',
    'jsonArray',
  ]);
  let payload: string;
  switch (kind) {
    case 'notJson':
      payload = '{"uri":';
      break;
    case 'emptyObject':
      payload = '{}';
      break;
    case 'mismatch':
      payload = capturePayload(honestSidecar).replace(
        '"durationMs":3400',
        '"durationMs":99',
      );
      break;
    case 'badSidecarRef':
      payload = JSON.stringify({
        ...(JSON.parse(capturePayload(null)) as Record<string, unknown>),
        poseSequence: { uri: 42, sha256: null },
      });
      break;
    default:
      payload = '[]';
  }
  // A corrupt payload is never trusted: the clip still plays from the row's
  // columns (no poster), but no sidecar reference survives → no skeleton.
  return {
    inputs: { payload: kind },
    seed: { capture: { payload } },
    expect: { state: 'ready', pose: 'none', caption: 'noPose' },
  };
};
CASES['sqlite.capture.partial'] = random => {
  const field = pick(random, ['duration_ms', 'width', 'height', 'uri', 'fps']);
  const value =
    field === 'uri'
      ? pick(random, ['', 'not-a-uri', 'file:///nonexistent.mov'])
      : pick(random, [0, -1, 'abc', 1e15, 0.5]);
  const overrides: CaptureRowOverrides = {
    [field]: value,
  } as CaptureRowOverrides;
  const clipGone =
    field === 'duration_ms' && (value === 0 || value === -1 || value === 'abc');
  return {
    inputs: { field, value },
    seed: { capture: overrides },
    // Columns disagree with the payload → metadata mismatch → the sidecar
    // ref is not trusted; a non-positive duration also drops the clip.
    expect: clipGone
      ? { state: 'ready', pose: 'none', caption: 'noClipNoPose' }
      : { state: 'ready', pose: 'none', caption: 'noPose' },
  };
};
CASES['sqlite.capture.infiniteDuration'] = () => ({
  inputs: { duration_ms: 'REAL +Inf' },
  seed: { capture: { duration_ms: Number.POSITIVE_INFINITY } },
  expect: { state: 'ready', pose: 'none', caption: 'any' },
  drive: async ctx => {
    const play = pressable(
      ctx.renderer,
      n => n.props.testID === 'form-review-play',
    );
    if (play) {
      await act(async () => {
        play.props.onPress();
      });
    }
  },
});
CASES['sqlite.capture.legacyRow'] = () => ({
  inputs: { payload: 'NULL (row predates evidence payloads)' },
  seed: { capture: { payload: null } },
  expect: { state: 'ready', pose: 'none', caption: 'noPose' },
});
CASES['sqlite.attempts.malformed'] = random => ({
  inputs: { rows: 'garbage session rows' },
  faults: [
    {
      match: STATEMENTS.attempts,
      mode: 'rows',
      rows: () => [
        {},
        { id: null, session_id: SESSION_ID, captured_at: null },
        {
          id: 7,
          session_id: 42,
          shot_type: null,
          overall_score: 'x',
          confidence: 'y',
        },
        ...(random() < 0.5
          ? [{ id: ANALYSIS_ID, session_id: SESSION_ID, captured_at: 'later' }]
          : []),
      ],
    },
  ],
  expect: HONEST,
});
CASES['sqlite.all.mixed'] = random => {
  const faults: StatementFault[] = [];
  const inputs: Record<string, unknown> = {};
  let hangs = false;
  let shotBroken = false;
  for (const statement of Object.keys(STATEMENTS) as StatementName[]) {
    const mode = pick(random, ['ok', 'ok', ...TIMING_MODES] as const);
    if (mode === 'ok') {
      inputs[statement] = 'ok';
      continue;
    }
    const built = timingFault(random, statement, mode);
    if (mode === 'timeout' || mode === 'never') hangs = true;
    if (statement === 'shot' && mode !== 'slow') shotBroken = true;
    faults.push(built.fault);
    inputs[statement] = built.inputs;
  }
  return {
    inputs,
    faults,
    expect: hangs
      ? { state: 'loading', pose: 'none' }
      : shotBroken
        ? { state: 'missing', pose: 'none' }
        : { state: 'ready', pose: 'any', caption: 'any' },
  };
};

// Pose sidecar — the native file read (Vision-provider artifact)
CASES['sidecar.read.throw'] = () => ({
  inputs: { read: 'synchronous throw' },
  seed: {
    sidecarFile: () => {
      throw new Error('injected: readTextFile threw');
    },
  },
  expect: NO_POSE,
});
CASES['sidecar.read.reject'] = () => ({
  inputs: { read: 'rejected promise' },
  seed: {
    sidecarFile: () => Promise.reject(new Error('injected: read rejected')),
  },
  expect: NO_POSE,
});
CASES['sidecar.read.never'] = () => ({
  inputs: { read: 'never resolves' },
  seed: { sidecarFile: () => new Promise(() => {}) },
  expect: { state: 'loading', pose: 'none' },
});
CASES['sidecar.read.slow'] = random => {
  const delay = randomInt(random, 200, 55_000);
  return {
    inputs: { read: 'slow', delayMs: delay },
    seed: {
      sidecarFile: () =>
        new Promise(resolve =>
          setTimeout(() => resolve(honestSidecarJson), delay),
        ),
    },
    expect: HONEST,
  };
};
CASES['sidecar.read.timeout'] = random => {
  const delay = randomInt(random, 61_000, 240_000);
  return {
    inputs: { read: 'resolves after the 60s budget', delayMs: delay },
    seed: {
      sidecarFile: () =>
        new Promise(resolve =>
          setTimeout(() => resolve(honestSidecarJson), delay),
        ),
    },
    expect: { state: 'loading', pose: 'none' },
  };
};
CASES['sidecar.read.nonString'] = random => {
  const value = pick(random, [
    42,
    null,
    undefined,
    { json: true },
    ['x'],
    true,
  ]);
  return {
    inputs: { read: 'resolves with a non-string', value: String(value) },
    seed: { sidecarFile: () => Promise.resolve(value) },
    expect: NO_POSE,
  };
};
CASES['sidecar.read.unavailable'] = () => ({
  inputs: { read: 'native module has no readTextFile' },
  seed: { sidecarFile: 'unavailable' },
  expect: NO_POSE,
});
CASES['sidecar.read.wrongFile'] = () => ({
  inputs: { read: 'bytes of a different file (hash mismatch)' },
  seed: { sidecarFile: honestSidecarJson.replace('"c":0.9', '"c":0.8') },
  expect: NO_POSE,
});
CASES['sidecar.content.notJson'] = random => ({
  inputs: { content: pick(random, ['garbage{', '', 'null', '[1,2]', '"str"']) },
  seed: { sidecarFile: 'garbage{' },
  expect: NO_POSE,
});
CASES['sidecar.content.truncated'] = random => {
  const cut = randomInt(random, 1, honestSidecarJson.length - 1);
  return {
    inputs: { content: 'truncated', keptBytes: cut },
    seed: { sidecarFile: honestSidecarJson.slice(0, cut) },
    expect: NO_POSE,
  };
};
for (const kind of [
  'wrongSchema',
  'partialFrames',
  'emptyFrames',
  'badCoords',
  'outOfRangeShown',
  'nonMonotonic',
  'missingJoints',
  'badTimestamps',
  'badVideo',
  'huge',
]) {
  CASES[`sidecar.content.${kind}`] = random => sidecarContentPlan(random, kind);
}
CASES['sidecar.ref.frameCountLie'] = random => {
  const ref = { ...honestSidecar, frameCount: pick(random, [0, 1, 9999, -1]) };
  return {
    inputs: { frameCount: ref.frameCount },
    seed: { sidecar: ref },
    expect: { state: 'ready', pose: 'any', caption: 'any' },
  };
};
CASES['sidecar.ref.wrongModel'] = () => ({
  inputs: { poseModelVersion: 'mediapipe-pose-1 (ref) vs apple (file)' },
  seed: { sidecar: { ...honestSidecar, poseModelVersion: 'mediapipe-pose-1' } },
  expect: { state: 'ready', pose: 'any', caption: 'any' },
});

// Route params / navigation
CASES['route.params.absent'] = () => ({
  inputs: { params: 'undefined (navigate without params)' },
  params: undefined,
  expect: { state: 'missing', pose: 'none' },
});
CASES['route.params.analysisIdMalformed'] = random => {
  const id = pick(random, [
    '',
    '   ',
    'x'.repeat(5000),
    `${ANALYSIS_ID}' OR 1=1 --`,
    '💥\u0000\uFFFF',
    ANALYSIS_ID.toUpperCase(),
    ' stress-analysis-1',
  ]);
  return {
    inputs: {
      analysisId:
        id.length > 60
          ? `${id.slice(0, 20)}…(${id.length})`
          : JSON.stringify(id),
    },
    params: { analysisId: id },
    expect: { state: 'missing', pose: 'none' },
  };
};
CASES['route.params.analysisIdWrongType'] = random => {
  const id = pick(random, [42, null, { id: ANALYSIS_ID }, ['a'], true]);
  return {
    inputs: { analysisId: JSON.stringify(id) },
    params: { analysisId: id },
    expect: { state: 'missing', pose: 'none' },
  };
};
CASES['route.params.phaseMalformed'] = random => {
  const phase = pick(random, [
    '',
    'not_a_phase',
    42,
    null,
    'CONTACT',
    { key: 'contact' },
    'swing_length',
  ]);
  return {
    inputs: { phase: JSON.stringify(phase) },
    params: { analysisId: ANALYSIS_ID, phase },
    expect: HONEST,
  };
};

CASES['navigation.abandonDuringLoad'] = random => {
  const delay = randomInt(random, 500, 30_000);
  const leaveAt = randomInt(random, 0, delay - 1);
  return {
    inputs: { evidenceDelayMs: delay, closeAtMs: leaveAt },
    faults: [{ match: STATEMENTS.shot, mode: 'slow', delayMs: delay }],
    expect: { state: 'absent', pose: 'none' },
    skipRecovery: true,
    drive: async ctx => {
      await ctx.advance(leaveAt);
      const close = pressable(
        ctx.renderer,
        n => n.props.accessibilityLabel === 'Close',
      );
      ctx.observed['closeVisibleWhileLoading'] = close !== null;
      if (!close) {
        ctx.broken.push('recovery-control: no Close while loading');
        return;
      }
      await act(async () => {
        close.props.onPress();
      });
      await ctx.flush();
    },
    after: async ctx => {
      const root = ctx.navRef.current?.getRootState();
      const top = root?.routes[root.index]?.name;
      ctx.observed['routeAfterAbandon'] = top;
      if (top !== 'Result')
        ctx.broken.push(`recovery-control: stack top ${String(top)}`);
      if (
        findByTestId(ctx.renderer, 'form-review-screen') ||
        screenState(ctx.renderer) === 'loading'
      ) {
        ctx.broken.push('recovery-control: screen still mounted after Close');
      }
    },
  };
};
CASES['navigation.abandonDuringSidecar'] = random => {
  const delay = randomInt(random, 500, 30_000);
  const leaveAt = randomInt(random, 0, delay - 1);
  return {
    inputs: { sidecarDelayMs: delay, closeAtMs: leaveAt },
    seed: {
      sidecarFile: () =>
        new Promise(resolve =>
          setTimeout(() => resolve(honestSidecarJson), delay),
        ),
    },
    expect: { state: 'absent', pose: 'none' },
    skipRecovery: true,
    drive: async ctx => {
      await ctx.advance(leaveAt);
      const close = pressable(
        ctx.renderer,
        n => n.props.accessibilityLabel === 'Close',
      );
      if (!close) {
        ctx.broken.push('recovery-control: no Close while loading');
        return;
      }
      await act(async () => {
        close.props.onPress();
      });
      await ctx.flush();
    },
    after: async ctx => {
      const root = ctx.navRef.current?.getRootState();
      if (root?.routes[root.index]?.name !== 'Result')
        ctx.broken.push('recovery-control: not back on Result');
      if (screenState(ctx.renderer) !== 'absent')
        ctx.broken.push(
          `recovery-control: screen state ${screenState(ctx.renderer)} after Close`,
        );
    },
  };
};
CASES['navigation.closeDuringHang'] = random => {
  const waitMs = randomInt(random, 100, 59_000);
  return {
    inputs: { evidence: 'never resolves', closeAtMs: waitMs },
    faults: [{ match: STATEMENTS.record, mode: 'never' }],
    expect: { state: 'absent', pose: 'none' },
    skipRecovery: true,
    drive: async ctx => {
      await ctx.advance(waitMs);
      const close = pressable(
        ctx.renderer,
        n => n.props.accessibilityLabel === 'Close',
      );
      if (!close) {
        ctx.broken.push('recovery-control: no Close while hung');
        return;
      }
      await act(async () => {
        close.props.onPress();
      });
      await ctx.flush();
    },
    after: async ctx => {
      const root = ctx.navRef.current?.getRootState();
      if (root?.routes[root.index]?.name !== 'Result')
        ctx.broken.push('recovery-control: not back on Result');
    },
  };
};
CASES['navigation.setParamsRace'] = random => {
  // The first analysis answers slowly; the route switches to the sibling
  // (0 phases → a single contact-only stop) before it lands.
  const firstDelay = randomInt(random, 2_000, 40_000);
  const switchAt = randomInt(random, 100, firstDelay - 100);
  return {
    inputs: { firstDelayMs: firstDelay, switchAtMs: switchAt },
    seed: { sibling: true },
    faults: [
      { match: STATEMENTS.shot, mode: 'slow', delayMs: firstDelay, times: 1 },
    ],
    expect: { state: 'ready', pose: 'any', caption: 'any' },
    drive: async ctx => {
      await ctx.advance(switchAt);
      await act(async () => {
        (
          ctx.navRef.current as unknown as {
            setParams: (p: unknown) => void;
          } | null
        )?.setParams({ analysisId: SIBLING_ANALYSIS_ID });
      });
      await ctx.flush();
    },
    after: async ctx => {
      const stops = stopCount(ctx.renderer);
      ctx.observed['stopsShown'] = stops;
      if (stops !== 1)
        ctx.broken.push(
          `honest-signal: shows ${String(stops)} stops — stale analysis won the race`,
        );
    },
  };
};
CASES['navigation.reanalyzeDoubleTap'] = random => {
  const taps = randomInt(random, 2, 6);
  return {
    inputs: { taps },
    expect: { state: 'absent', pose: 'none' },
    skipRecovery: true,
    drive: async ctx => {
      const button = pressable(
        ctx.renderer,
        n => n.props.testID === 'form-review-reanalyze',
      );
      if (!button) {
        ctx.broken.push('recovery-control: no Re-analyze control');
        return;
      }
      await act(async () => {
        for (let i = 0; i < taps; i += 1) button.props.onPress();
      });
      await ctx.flush();
      // The handoff is single-shot with a 30s TTL: inspect it as AnalyzeScreen
      // would, right after the navigation lands.
      const handoff = peekTryAgainHandoff();
      ctx.observed['handoff'] = handoff;
      if (!handoff)
        ctx.broken.push('honest-signal: try-again handoff not armed');
      else if (
        handoff.sessionId !== SESSION_ID ||
        handoff.declaredStroke !== 'forehand_drive'
      ) {
        ctx.broken.push(
          `honest-signal: handoff carries ${JSON.stringify(handoff)}`,
        );
      }
    },
    after: async ctx => {
      const root = ctx.navRef.current?.getRootState();
      const names = root?.routes.map(r => r.name) ?? [];
      ctx.observed['routes'] = names;
      if (names.filter(n => n === 'Analyze').length !== 1)
        ctx.broken.push(
          `recovery-control: Analyze pushed ${names.filter(n => n === 'Analyze').length}x`,
        );
      const analyze = findByTestId(ctx.renderer, 'analyze-stub');
      if (!analyze || textOf(analyze) !== 'camera')
        ctx.broken.push('honest-signal: Analyze not opened with source camera');
    },
  };
};
CASES['navigation.backAndReturn'] = random => {
  const rounds = randomInt(random, 2, 6);
  return {
    inputs: { rounds },
    expect: HONEST,
    drive: async ctx => {
      for (let i = 0; i < rounds; i += 1) {
        const back = pressable(
          ctx.renderer,
          n => n.props.testID === 'form-review-back',
        );
        if (!back) {
          ctx.broken.push(`recovery-control: no Back on round ${i}`);
          return;
        }
        await act(async () => {
          back.props.onPress();
        });
        await ctx.advance(randomInt(random, 50, 1500));
        await act(async () => {
          (
            ctx.navRef.current as unknown as {
              navigate: (n: string, p: unknown) => void;
            } | null
          )?.navigate('FormReview', { analysisId: ANALYSIS_ID });
        });
        await ctx.flush();
      }
      ctx.observed['sqlAfterRounds'] = mockSqlite.log.length;
    },
  };
};

// Clock
CASES['clock.play60s'] = random => {
  const speedTaps = randomInt(random, 0, 2);
  const autoPauseOff = random() < 0.5;
  return {
    inputs: { speedTaps, autoPauseOff },
    expect: HONEST,
    drive: async ctx => {
      const tap = async (testID: string) => {
        const node = pressable(ctx.renderer, n => n.props.testID === testID);
        if (!node) {
          ctx.broken.push(`recovery-control: no ${testID}`);
          return;
        }
        await act(async () => {
          node.props.onPress();
        });
      };
      for (let i = 0; i < speedTaps; i += 1) await tap('form-review-speed');
      if (autoPauseOff) await tap('form-review-autopause');
      await tap('form-review-play');
    },
    after: async ctx => {
      const stage = findByTestId(ctx.renderer, 'form-review-stage');
      const hint = stage ? String(stage.props.accessibilityHint) : '';
      ctx.observed['stageHintAfter60s'] = hint;
      ctx.observed['stageLabelAfter60s'] = stage
        ? String(stage.props.accessibilityLabel)
        : null;
      if (hint === 'Pauses the replay')
        ctx.broken.push(
          'no-infinite-spinner: replay still playing after 60s of a 3.4s clip',
        );
    },
  };
};
CASES['clock.jumpForward'] = () => ({
  inputs: { jump: 'one 10-minute timer advance while playing' },
  expect: HONEST,
  drive: async ctx => {
    const play = pressable(
      ctx.renderer,
      n => n.props.testID === 'form-review-play',
    );
    if (!play) return;
    await act(async () => {
      play.props.onPress();
    });
    await act(async () => {
      jest.advanceTimersByTime(600_000);
    });
  },
});
CASES['clock.systemTimeBackwards'] = random => {
  const jump = randomInt(random, 1, 365 * 24 * 3600) * 1000;
  return {
    inputs: { systemClockJumpBackMs: jump },
    expect: HONEST,
    drive: async ctx => {
      const play = pressable(
        ctx.renderer,
        n => n.props.testID === 'form-review-play',
      );
      if (!play) return;
      await act(async () => {
        play.props.onPress();
      });
      await ctx.advance(500);
      jest.setSystemTime(Date.now() - jump);
      await ctx.advance(500);
    },
  };
};
CASES['clock.rapidScrub'] = random => {
  const actions = randomInt(random, 20, 80);
  return {
    inputs: { actions },
    expect: HONEST,
    drive: async ctx => {
      const ids = [
        'form-review-play',
        'form-review-next-stop',
        'form-review-prev-stop',
        'form-review-stage',
        'form-review-speed',
        'form-review-autopause',
      ];
      for (let i = 0; i < actions; i += 1) {
        const node = pressable(
          ctx.renderer,
          n => n.props.testID === pick(random, ids),
        );
        if (node) {
          await act(async () => {
            node.props.onPress();
          });
        }
        if (random() < 0.5) await ctx.advance(randomInt(random, 1, 400));
      }
    },
  };
};

// ─── Campaign ────────────────────────────────────────────────────────────────

describe('FormReviewScreen × failure injection (real navigator + real SQLite)', () => {
  for (const [caseName, build] of Object.entries(CASES)) {
    const run = caseSelected(caseName) ? it : it.skip;
    caseSeeds(caseName).forEach((seed, index) => {
      run(
        `${caseName} seed ${seed} run ${index + 1}`,
        async () => {
          const plan = build(seededRandom(seed));
          await runScenario(caseName, seed, plan);
        },
        120_000,
      );
    });
  }
});
