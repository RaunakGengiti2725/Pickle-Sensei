import type React from 'react';
import type { Text as TextType } from 'react-native';
import type TestRendererType from 'react-test-renderer';
import {
  capture,
  finishRow,
  planCampaign,
  summarize,
  writeJsonArtifact,
  type StressRow,
} from '../../stress-harness/mod-app-root/campaign';
import {
  hostileThrowable,
  safeDescribe,
  THROWABLE_FAMILIES,
  type GeneratedThrowable,
} from '../../stress-harness/mod-app-root/malformedCorpus';
import { makePrng } from '../../stress-harness/mod-app-root/prng';

/**
 * STRESS · mod-app-root · lens boundary-malformed · App.tsx RootErrorBoundary
 *
 * The root boundary is the last line between a render throw and a dead app.
 * A component can `throw` ANY value, and `componentDidCatch` fingerprints
 * it (`crashFingerprint`) before rendering the recoverable ErrorState — so
 * the whole hostile corpus is thrown from a child during render: Errors with
 * non-string / symbol / null-prototype `name`/`message`/`stack`, throwing
 * getters, 64KB–1MB messages and stacks, Error subclasses, frozen errors,
 * deep and circular `cause` chains, primitives (NaN, -0, Infinity, BigInt,
 * Symbol, null, undefined), null-prototype objects, hostile coercion
 * objects, revoked/trapping Proxies, prototype-pollution payloads, empty
 * collections.
 *
 * Thenables are excluded from this corpus: throwing one during render is
 * React's Suspense protocol, not an error, so the boundary is not supposed to
 * see it.
 *
 * Invariants (per iteration):
 * - mount-no-escape        mounting <RootErrorBoundary><Bomb/></> never
 *                          throws out of the renderer (a throw here is what
 *                          the user experiences as a hard crash)
 * - error-state-shown      the "Something went wrong" ErrorState with a
 *                          single "Try again" button is rendered
 * - crash-recorded         exactly one non-fatal 'crash' stability event
 *                          with an 8-hex fingerprint was recorded
 * - fingerprint-stable     the same hostile value fingerprints identically
 *                          on a second, independent boundary
 * - retry-recatches        pressing "Try again" while the child still throws
 *                          lands back on the ErrorState (no escape)
 * - retry-restores-child   pressing "Try again" once the child no longer
 *                          throws re-renders the children
 * - unmount-no-throw       unmounting from the caught state never throws
 *
 * Isolation: a throw that escapes the root can leave React's reconciler
 * mid-work ("Should not already be working" on every later render). After
 * any escape the harness probes a trivial mount and, if React is poisoned,
 * resets the module registry and reloads react + react-native +
 * react-test-renderer + App (an "epoch") so one seed's damage never leaks
 * into the next seed's verdict. (`jest.resetModules`, not `isolateModules`:
 * react-native lazily `require()`s at render time, and those must resolve to
 * the same React copy as the renderer.) Epoch reloads are counted in the
 * summary (`reactPoisonedAfterSeeds`) — they are themselves evidence.
 *
 * Replay one row: STRESS_SEED=<seed> npx jest --ci __tests__/stress/modAppRoot.rootErrorBoundary
 * Full campaign:  STRESS_ITER=3000 npx jest --ci __tests__/stress/modAppRoot.rootErrorBoundary
 */

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View, SafeAreaProvider: View };
});
jest.mock('../../src/navigation/RootNavigator', () => ({
  RootNavigator: () => null,
}));
jest.mock('../../src/screens/OnboardingScreen', () => ({
  OnboardingScreen: () => null,
}));
jest.mock('../../src/screens/WelcomeScreen', () => ({
  WelcomeScreen: () => null,
}));
jest.mock('../../src/screens/SignInScreen', () => ({
  SignInScreen: () => null,
}));
jest.mock('../../src/screens/SplashScreen', () => ({
  SplashScreen: () => null,
}));
jest.mock('../../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));
jest.mock('../../src/walkthrough/walkthroughStore', () => ({
  useWalkthroughStore: () => async () => {},
}));
jest.mock('../../src/notifications/useNotificationBootstrap', () => ({
  useNotificationBootstrap: () => {},
}));
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));
jest.mock('../../src/state/appStore', () => ({
  useAppStore: () => undefined,
}));
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: () => undefined,
}));

/** Jest's module-scoped require (honours jest.mock + resetModules). */
declare const require: (id: string) => unknown;

const HEX8 = /^[0-9a-f]{8}$/;
const ERROR_TITLE = 'Something went wrong';

type AppModule = typeof import('../../App');
type TelemetryModule = typeof import('../../src/analysis/stabilityTelemetry');
type ComponentsModule = typeof import('../../src/design/components');
type Renderer = TestRendererType.ReactTestRenderer;

/** One consistent set of React + renderer + App modules. */
interface Epoch {
  React: typeof React;
  Text: typeof TextType;
  TestRenderer: typeof TestRendererType;
  act: typeof TestRendererType.act;
  RootErrorBoundary: AppModule['RootErrorBoundary'];
  stabilitySlo: TelemetryModule['stabilitySlo'];
  Button: ComponentsModule['Button'];
}

function loadEpoch(reset: boolean): Epoch {
  if (reset) jest.resetModules();
  const R = require('react') as typeof React;
  const RN = require('react-native') as typeof import('react-native');
  const TR = require('react-test-renderer') as typeof TestRendererType;
  const AppMod = require('../../App') as AppModule;
  const Telemetry =
    require('../../src/analysis/stabilityTelemetry') as TelemetryModule;
  const Components = require('../../src/design/components') as ComponentsModule;
  return {
    React: R,
    Text: RN.Text,
    TestRenderer: TR,
    act: TR.act,
    RootErrorBoundary: AppMod.RootErrorBoundary,
    stabilitySlo: Telemetry.stabilitySlo,
    Button: Components.Button,
  };
}

type CrashEvent = Extract<
  ReturnType<TelemetryModule['stabilitySlo']['events']>[number],
  { kind: 'crash' }
>;

function crashEventsSince(epoch: Epoch, start: number): CrashEvent[] {
  return epoch.stabilitySlo
    .events()
    .slice(start)
    .filter((event): event is CrashEvent => event.kind === 'crash');
}

interface Fuse {
  armed: boolean;
  payload: unknown;
}

function makeBomb(epoch: Epoch) {
  return function Bomb({ fuse }: { fuse: Fuse }) {
    if (fuse.armed) throw fuse.payload;
    return epoch.React.createElement(epoch.Text, null, 'CHILD_OK');
  };
}

function allText(epoch: Epoch, renderer: Renderer): string {
  const probe = capture(() =>
    renderer.root
      .findAllByType(epoch.Text)
      .map(node => node.props.children as unknown)
      .flat()
      .filter((c): c is string => typeof c === 'string')
      .join('\n'),
  );
  return probe.threw ? '' : probe.value;
}

function tryAgainButtons(epoch: Epoch, renderer: Renderer) {
  const probe = capture(() =>
    renderer.root
      .findAllByType(epoch.Button)
      .filter(node => node.props.label === 'Try again'),
  );
  return probe.threw ? [] : probe.value;
}

function showsErrorState(epoch: Epoch, renderer: Renderer): boolean {
  return (
    allText(epoch, renderer).includes(ERROR_TITLE) &&
    tryAgainButtons(epoch, renderer).length === 1
  );
}

function pressTryAgain(epoch: Epoch, renderer: Renderer) {
  return capture(() => {
    epoch.act(() => {
      (
        tryAgainButtons(epoch, renderer)[0]?.props as {
          onPress?: () => void;
        }
      ).onPress?.();
    });
  });
}

function isThenable(value: unknown): boolean {
  const probe = capture(
    () =>
      value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      typeof (value as { then?: unknown }).then === 'function',
  );
  return !probe.threw && probe.value;
}

/** Draw from the corpus, skipping thenables (Suspense protocol, not errors). */
function boundaryThrowable(rng: () => number): GeneratedThrowable {
  for (;;) {
    const candidate = hostileThrowable(rng);
    if (!isThenable(candidate.value)) return candidate;
  }
}

function mountBoundary(
  epoch: Epoch,
  Bomb: ReturnType<typeof makeBomb>,
  fuse: Fuse,
) {
  let renderer: Renderer | null = null;
  const outcome = capture(() => {
    epoch.act(() => {
      renderer = epoch.TestRenderer.create(
        epoch.React.createElement(
          epoch.RootErrorBoundary,
          null,
          epoch.React.createElement(Bomb, { fuse }),
        ),
      );
    });
  });
  return { renderer, outcome };
}

/** True when a trivial healthy mount works — i.e. React is not poisoned. */
function reactHealthy(epoch: Epoch): boolean {
  const probe = capture(() => {
    let created!: Renderer;
    epoch.act(() => {
      created = epoch.TestRenderer.create(
        epoch.React.createElement(epoch.Text, null, 'probe'),
      );
    });
    return created;
  });
  if (probe.threw) return false;
  const text = allText(epoch, probe.value);
  capture(() => epoch.act(() => probe.value.unmount()));
  return text.includes('probe');
}

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let epoch: Epoch;
const reactPoisonedAfterSeeds: number[] = [];

beforeAll(() => {
  // React logs every caught render error; the corpus produces thousands.
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  epoch = loadEpoch(false);
});

afterAll(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

const plan = planCampaign('root-error-boundary', 40);

function runIteration(seed: number): StressRow {
  const rng = makePrng(seed);
  const throwable = boundaryThrowable(rng);
  const started = Date.now();
  const Bomb = makeBomb(epoch);
  const mounted: Renderer[] = [];

  // ── first mount: child throws during render ──
  const fuse: Fuse = { armed: true, payload: throwable.value };
  let eventsBefore = epoch.stabilitySlo.events().length;
  const first = mountBoundary(epoch, Bomb, fuse);
  if (first.renderer) mounted.push(first.renderer);
  const firstEvents = crashEventsSince(epoch, eventsBefore);
  const mountNoEscape = !first.outcome.threw;
  const errorStateShown = first.renderer
    ? showsErrorState(epoch, first.renderer)
    : false;
  const crashRecorded =
    firstEvents.length === 1 &&
    firstEvents[0]?.fatal === false &&
    HEX8.test(firstEvents[0].fingerprint);

  // ── second, independent boundary: fingerprint must match ──
  eventsBefore = epoch.stabilitySlo.events().length;
  const second = mountBoundary(epoch, Bomb, {
    armed: true,
    payload: throwable.value,
  });
  if (second.renderer) mounted.push(second.renderer);
  const secondEvents = crashEventsSince(epoch, eventsBefore);
  const fingerprintStable =
    !second.outcome.threw &&
    firstEvents.length === 1 &&
    secondEvents.length === 1 &&
    firstEvents[0]?.fingerprint === secondEvents[0]?.fingerprint;

  // ── retry while still armed: must land back on the ErrorState ──
  let retryRecatches = false;
  let retryRecatchThrew: string | null = null;
  if (first.renderer && errorStateShown) {
    const press = pressTryAgain(epoch, first.renderer);
    retryRecatchThrew = press.threw ? press.error : null;
    retryRecatches = !press.threw && showsErrorState(epoch, first.renderer);
  }

  // ── retry once the child is healthy: children must come back ──
  let retryRestores = false;
  let retryRestoreThrew: string | null = null;
  if (first.renderer && retryRecatches) {
    fuse.armed = false;
    const press = pressTryAgain(epoch, first.renderer);
    retryRestoreThrew = press.threw ? press.error : null;
    const text = allText(epoch, first.renderer);
    retryRestores =
      !press.threw && text.includes('CHILD_OK') && !text.includes(ERROR_TITLE);
  }

  // ── unmount ──
  let unmountNoThrow = true;
  let unmountThrew: string | null = null;
  for (const renderer of mounted) {
    const done = capture(() => {
      epoch.act(() => renderer.unmount());
    });
    if (done.threw) {
      unmountNoThrow = false;
      unmountThrew = done.error;
    }
  }

  // ── isolation: never let one seed's escape poison the next seed ──
  let reactPoisoned = false;
  if (first.outcome.threw || second.outcome.threw || !unmountNoThrow) {
    reactPoisoned = !reactHealthy(epoch);
    if (reactPoisoned) {
      reactPoisonedAfterSeeds.push(seed);
      epoch = loadEpoch(true);
    }
  }

  return finishRow({
    suite: plan.suite,
    scenario: 'render-throw→boundary→retry',
    seed,
    inputs: {
      family: throwable.family,
      label: throwable.label,
      describe: throwable.describe,
      valueType: safeDescribe(throwable.value),
    },
    observed: {
      mountThrew: first.outcome.threw ? first.outcome.error : null,
      secondMountThrew: second.outcome.threw ? second.outcome.error : null,
      crashEvents: firstEvents.length,
      fingerprint: firstEvents[0]?.fingerprint ?? null,
      secondFingerprint: secondEvents[0]?.fingerprint ?? null,
      retryRecatchThrew,
      retryRestoreThrew,
      unmountThrew,
      reactPoisoned,
    },
    invariants: {
      'mount-no-escape': mountNoEscape,
      'error-state-shown': errorStateShown,
      'crash-recorded': crashRecorded,
      'fingerprint-stable': fingerprintStable,
      'retry-recatches': retryRecatches,
      'retry-restores-child': retryRestores,
      'unmount-no-throw': unmountNoThrow,
    },
    durationMs: Date.now() - started,
  });
}

describe(`RootErrorBoundary × hostile render throws (${plan.iterations} seeds)`, () => {
  const rows: StressRow[] = [];
  const wallStart = Date.now();

  afterAll(() => {
    const summary = summarize(
      plan,
      rows,
      Date.now() - wallStart,
      row => String(row.inputs['family']),
      row =>
        row.ok
          ? 'held'
          : row.invariants['mount-no-escape'] === false
            ? 'broken-escaped-root'
            : 'broken',
    );
    writeJsonArtifact('root-error-boundary.rows.json', rows);
    writeJsonArtifact('root-error-boundary.summary.json', {
      ...summary,
      familiesCovered: THROWABLE_FAMILIES.filter(family =>
        rows.some(row => row.inputs['family'] === family),
      ),
      reactPoisonedAfterSeeds,
      escapedRoot: rows
        .filter(row => row.invariants['mount-no-escape'] === false)
        .map(row => ({
          seed: row.seed,
          family: row.inputs['family'],
          label: row.inputs['label'],
          thrown: row.observed['mountThrew'],
          reactPoisoned: row.observed['reactPoisoned'],
        })),
    });
  });

  it.each(plan.seeds.map(seed => [seed] as const))(
    'seed %d: a hostile render throw lands on the recoverable ErrorState',
    seed => {
      const row = runIteration(seed);
      rows.push(row);
      expect(row.failed).toEqual([]);
    },
  );
});
