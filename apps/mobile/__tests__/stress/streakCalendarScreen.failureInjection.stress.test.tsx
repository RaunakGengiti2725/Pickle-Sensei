/**
 * STRESS — failure injection for StreakCalendarScreen.
 *
 * The screen is rendered inside a REAL `NavigationContainer` + native-stack
 * navigator with the REAL consistency store, engine and hooks. Only native
 * modules (safe-area, linear gradient, SQLite) and `fetch` are replaced.
 *
 * Every iteration is replayable from its seed:
 *   STRESS_SEED=<n> npx jest --ci __tests__/stress/streakCalendarScreen.failureInjection
 * Scale the random campaign with STRESS_ITER (default 72). Write the results
 * table with STRESS_OUT=/abs/path.json.
 */
import fs from 'node:fs';
import React from 'react';
import { ActivityIndicator, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import {
  BAD_TIME_ZONES,
  FAULT_TARGETS,
  MALFORMED_KV_VARIANTS,
  MALFORMED_SHOT_VARIANTS,
  NEIGHBOUR_KEY,
  NEIGHBOUR_LEDGER,
  ODD_SYSTEM_TIMES,
  buildFixture,
  checkLedgerIntegrity,
  createFakeDb,
  faultForTarget,
  fixtureActivities,
  isPersistedCorruption,
  kvValueUnderFault,
  makeRng,
  withWritePath,
  type FakeDbController,
  type Fault,
  type Fixture,
  type IterationResult,
} from './streakCalendarFaultHarness';

// ------------------------------------------------------------- mocks ----
// Native modules only. Navigation, stores, hooks and the engine are real.

const mockDbRef: { current: FakeDbController | null } = { current: null };
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    const controller = mockDbRef.current;
    if (!controller) throw new Error('stress harness: no fake db installed');
    if (controller.getDbThrows) {
      controller.getDbThrowCount += 1;
      throw new Error('injected getDb throw');
    }
    return controller.db;
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const mock = require('react-native-safe-area-context/jest/mock');
  return mock.default ?? mock;
});

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

// Native modules the screen must never reach. Requiring one records the
// touch and throws, so a hidden dependency shows up as a BROKEN iteration.
const mockNativeTouched: string[] = [];
jest.mock('react-native-keychain', () => {
  mockNativeTouched.push('react-native-keychain');
  throw new Error('injected: keychain unavailable');
});
jest.mock('react-native-purchases', () => {
  mockNativeTouched.push('react-native-purchases');
  throw new Error('injected: RevenueCat unavailable');
});
jest.mock('@react-native-google-signin/google-signin', () => {
  mockNativeTouched.push('@react-native-google-signin/google-signin');
  throw new Error('injected: google sign-in unavailable');
});
jest.mock('react-native-notify-kit', () => {
  mockNativeTouched.push('react-native-notify-kit');
  throw new Error('injected: notifications unavailable');
});
jest.mock('react-native-video', () => {
  mockNativeTouched.push('react-native-video');
  throw new Error('injected: video unavailable');
});

import { StreakCalendarScreen } from '../../src/screens/StreakCalendarScreen';
import type { RootStackParams } from '../../src/navigation/params';
import { useConsistencyStore } from '../../src/consistency/store';
import {
  buildConsistencySnapshot,
  type ConsistencySnapshot,
} from '../../src/consistency/engine';
import { parseConsistencyLedger } from '../../src/consistency/store';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

// ----------------------------------------------------------- helpers ----

const Stack = createNativeStackNavigator<RootStackParams>();

function LaunchScreen() {
  return <Text>[stress-launch]</Text>;
}

class Boundary extends React.Component<
  { onError: (error: unknown) => void; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? (
      <Text>[stress-boundary-caught]</Text>
    ) : (
      this.props.children
    );
  }
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => React.Children.toArray(node.props.children))
    .filter(child => ['string', 'number'].includes(typeof child))
    .join(' ')
    .replace(/\s+/g, ' ');
}

function hostPressables(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  // The Pressable element PressableScale renders: it carries the label, the
  // accessibilityState (disabled) and the onPress the user would trigger.
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.accessibilityState === 'object' &&
      typeof node.props.onPress === 'function',
  );
}

function hasTestId(renderer: TestRenderer.ReactTestRenderer, id: string) {
  return renderer.root.findAllByProps({ testID: id }).length > 0;
}

function heroNumbers(text: string) {
  const streak = /(\d+) DAYS? STREAK/.exec(text);
  const xp = /MOMENTUM LEVEL (\d+) (\d+) XP/.exec(text);
  const longest = /(\d+) LONGEST/.exec(text);
  const trained = /(\d+) DAYS TRAINED/.exec(text);
  return {
    streak: streak ? Number(streak[1]) : null,
    level: xp ? Number(xp[1]) : null,
    xp: xp ? Number(xp[2]) : null,
    longest: longest ? Number(longest[1]) : null,
    trained: trained ? Number(trained[1]) : null,
  };
}

const CORRUPT_TEXT = /\bNaN\b|\bundefined\b|\bnull\b|Invalid Date|\[object /;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Advance fake time in 5s slices, flushing React + microtasks between. */
async function advance(ms: number) {
  let left = ms;
  while (left > 0) {
    const step = Math.min(5000, left);
    left -= step;
    await act(async () => {
      jest.advanceTimersByTime(step);
    });
    await flush();
  }
}

function resetStore() {
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
}

function effectiveTimeZone(fixture: Fixture, fault: Fault): string {
  if (fault.target !== 'clock.timeZone') return fixture.timeZone;
  if (fault.kind === 'throw') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: fault.detail });
    return fault.detail || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Ground truth the screen must show once the database answers: shots plus
 * whatever drills the persisted ledger legitimately carries. With
 * `ledger: 'unreadable'` treats the ledger as unreadable (the store's
 * documented degrade path); `ledger: 'healthy'` ignores a persisted-corruption
 * fault (the state before a 'second'-phase fault is armed).
 */
function truthFor(
  fixture: Fixture,
  fault: Fault,
  ledgerMode: 'faulted' | 'unreadable' | 'healthy' = 'faulted',
): ConsistencySnapshot {
  const activities = fixtureActivities({
    ...fixture,
    drills: [],
  });
  const ledgerRaw =
    ledgerMode === 'healthy'
      ? fixture.ledgerRaw
      : kvValueUnderFault(
          fixture,
          fault.target === 'sqlite.kvRead' ? fault : null,
        );
  const ledger =
    ledgerMode === 'unreadable'
      ? { drills: [] as ReturnType<typeof parseConsistencyLedger>['drills'] }
      : parseConsistencyLedger(ledgerRaw);
  for (const drill of ledger.drills) {
    activities.push({
      kind: 'drill',
      atIso: drill.completedAtIso,
      label: drill.title || drill.slug,
    });
  }
  const nowIso =
    fault.target === 'clock.systemTime' ? fault.detail : fixture.nowIso;
  return buildConsistencySnapshot(activities, {
    asOfIso: nowIso,
    timeZone: effectiveTimeZone(fixture, fault),
  });
}

/** Faults after which the visible numbers must equal the ground truth. */
function truthIsKnowable(fault: Fault): boolean {
  if (fault.target === 'sqlite.shots') {
    return fault.kind !== 'malformed' && fault.kind !== 'partial';
  }
  return true;
}

interface Scene {
  renderer: TestRenderer.ReactTestRenderer;
  nav: ReturnType<typeof createNavigationContainerRef<RootStackParams>>;
  boundaryErrors: unknown[];
}

async function mountScene(): Promise<Scene> {
  const nav = createNavigationContainerRef<RootStackParams>();
  const boundaryErrors: unknown[] = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Boundary onError={error => boundaryErrors.push(error)}>
        <NavigationContainer ref={nav}>
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Tabs" component={LaunchScreen as never} />
            <Stack.Screen
              name="StreakCalendar"
              component={StreakCalendarScreen}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </Boundary>,
    );
  });
  await flush();
  return { renderer, nav, boundaryErrors };
}

async function openCalendar(scene: Scene) {
  await act(async () => {
    scene.nav.navigate('StreakCalendar');
  });
  await flush();
}

async function goBack(scene: Scene) {
  await act(async () => {
    if (scene.nav.canGoBack()) scene.nav.goBack();
  });
  await flush();
}

async function press(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): Promise<boolean> {
  const [host] = hostPressables(renderer, label);
  if (!host) return false;
  await act(async () => {
    host.props.onPress();
  });
  await flush();
  return true;
}

// -------------------------------------------------------- invariants ----

interface Check {
  name: string;
  ok: boolean;
  note: string;
}

function checkTree(scene: Scene, fetchSpy: jest.Mock): Check[] {
  const text = textOf(scene.renderer);
  const checks: Check[] = [];
  checks.push({
    name: 'no-render-crash',
    ok: scene.boundaryErrors.length === 0,
    note: scene.boundaryErrors.map(e => String(e)).join('; '),
  });
  checks.push({
    name: 'no-infinite-spinner',
    ok: scene.renderer.root.findAllByType(ActivityIndicator).length === 0,
    note: '',
  });
  checks.push({
    name: 'no-corrupt-text',
    ok: !CORRUPT_TEXT.test(text),
    note: (CORRUPT_TEXT.exec(text) ?? [''])[0],
  });
  checks.push({
    name: 'fetch-never-called',
    ok: fetchSpy.mock.calls.length === 0,
    note: `${fetchSpy.mock.calls.length} fetch calls`,
  });
  checks.push({
    name: 'unrelated-native-untouched',
    ok: mockNativeTouched.length === 0,
    note: mockNativeTouched.join(','),
  });
  return checks;
}

function checkErrorState(scene: Scene): Check[] {
  const retry = hostPressables(scene.renderer, 'Try again');
  const back = hostPressables(scene.renderer, 'Back');
  const text = textOf(scene.renderer);
  return [
    {
      name: 'error-card-visible',
      ok:
        hasTestId(scene.renderer, 'streak-load-error') &&
        text.includes('Couldn’t load your training history'),
      note: text.slice(0, 120),
    },
    {
      name: 'retry-control-enabled',
      ok:
        retry.length === 1 &&
        !(retry[0]!.props.accessibilityState?.disabled === true),
      note: `${retry.length} retry controls`,
    },
    {
      name: 'back-control-present',
      ok: back.length >= 1,
      note: `${back.length} back controls`,
    },
    {
      name: 'no-fake-success-hero',
      ok: !hasTestId(scene.renderer, 'streak-hero'),
      note: '',
    },
  ];
}

function checkHero(scene: Scene, truth: ConsistencySnapshot | null): Check[] {
  const text = textOf(scene.renderer);
  const numbers = heroNumbers(text);
  const checks: Check[] = [
    {
      name: 'hero-visible',
      ok: hasTestId(scene.renderer, 'streak-hero') && numbers.streak !== null,
      note: text.slice(0, 120),
    },
    {
      name: 'back-control-present',
      ok: hostPressables(scene.renderer, 'Back').length >= 1,
      note: '',
    },
  ];
  if (truth) {
    const expected = {
      streak: truth.currentStreak,
      level: truth.momentum.level,
      xp: truth.momentumXp,
      longest: truth.longestStreak,
      trained: truth.totalTrainedDays,
    };
    checks.push({
      name: 'hero-matches-truth',
      ok:
        numbers.streak === expected.streak &&
        numbers.level === expected.level &&
        numbers.xp === expected.xp &&
        numbers.longest === expected.longest &&
        numbers.trained === expected.trained,
      note: `seen=${JSON.stringify(numbers)} truth=${JSON.stringify(expected)}`,
    });
    if (truth.trainedToday) {
      checks.push({
        name: 'today-auto-selected',
        ok: hasTestId(scene.renderer, 'streak-day-detail'),
        note: 'trainedToday but no day detail',
      });
    }
  }
  return checks;
}

/**
 * The device time zone is whatever `Intl.DateTimeFormat()` (no explicit
 * zone) resolves to. Formatters constructed WITH an explicit zone are the
 * engine's own and stay real, so only the device-clock dependency is faulted.
 */
function installDeviceTimeZone(fixture: Fixture, fault: Fault): () => void {
  const RealDTF = Intl.DateTimeFormat;
  const realResolved = RealDTF.prototype.resolvedOptions;
  const deviceZoneInstances = new WeakSet<Intl.DateTimeFormat>();
  function DeviceDTF(
    this: unknown,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    const instance = new RealDTF(locales, options);
    if (!options || options.timeZone === undefined) {
      deviceZoneInstances.add(instance);
    }
    return instance;
  }
  DeviceDTF.prototype = RealDTF.prototype;
  DeviceDTF.supportedLocalesOf = RealDTF.supportedLocalesOf;
  Intl.DateTimeFormat = DeviceDTF as unknown as typeof Intl.DateTimeFormat;
  RealDTF.prototype.resolvedOptions = function (this: Intl.DateTimeFormat) {
    const real = realResolved.call(this);
    if (!deviceZoneInstances.has(this)) return real;
    if (fault.target === 'clock.timeZone') {
      if (fault.kind === 'throw') throw new Error('injected tz throw');
      return { ...real, timeZone: fault.detail };
    }
    return { ...real, timeZone: fixture.timeZone };
  };
  return () => {
    RealDTF.prototype.resolvedOptions = realResolved;
    Intl.DateTimeFormat = RealDTF;
  };
}

// ----------------------------------------------------- one iteration ----

/** Faults the store surfaces as `loadError` (the ledger read is caught). */
function isLoadFailure(fault: Fault): boolean {
  return (
    (fault.target === 'sqlite.getDb' || fault.target === 'sqlite.shots') &&
    (fault.kind === 'throw' || fault.kind === 'reject')
  );
}

/** Ledger-read failures the store degrades to a shots-only snapshot. */
function isLedgerReadFailure(fault: Fault): boolean {
  return (
    fault.target === 'sqlite.kvRead' &&
    (fault.kind === 'throw' || fault.kind === 'reject')
  );
}

function isHang(fault: Fault): boolean {
  return fault.kind === 'never';
}

async function runIteration(seed: number): Promise<IterationResult> {
  const started = Date.now();
  const rng = makeRng(seed);
  const built = buildFixture(rng);
  const target = rng.pick(FAULT_TARGETS);
  const fault = faultForTarget(rng, target);
  const fixture = target === 'sqlite.kvWrite' ? withWritePath(built) : built;
  return runScenario(seed, fixture, fault, started);
}

async function runScenario(
  seed: number,
  fixture: Fixture,
  fault: Fault,
  started: number,
): Promise<IterationResult> {
  jest.useFakeTimers();
  jest.setSystemTime(
    Date.parse(
      fault.target === 'clock.systemTime' ? fault.detail : fixture.nowIso,
    ),
  );
  mockNativeTouched.length = 0;

  const controller = createFakeDb(fixture);
  mockDbRef.current = controller;
  resetStore();
  setActiveDataOwner(fixture.owner);
  const ownerKey = `consistency:${fixture.owner}`;
  // What is really on disk at the start (persisted corruption replaces it).
  const persistedLedger = isPersistedCorruption(fault)
    ? kvValueUnderFault(fixture, fault)
    : fixture.ledgerRaw;

  const fetchSpy = jest.fn(() => {
    if (fault.target === 'fetch') {
      if (fault.kind === 'throw') throw new Error('injected fetch throw');
      if (fault.kind === 'reject') {
        return Promise.reject(new Error('injected fetch reject'));
      }
      return new Promise<never>(() => {});
    }
    return Promise.reject(new Error('stress: fetch must not be called'));
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchSpy as unknown as typeof fetch;

  const truth = truthIsKnowable(fault) ? truthFor(fixture, fault) : null;
  const shotsOnlyTruth = truthIsKnowable(fault)
    ? truthFor(fixture, fault, 'unreadable')
    : null;
  const healthyTruth = truthIsKnowable(fault)
    ? truthFor(fixture, fault, 'healthy')
    : null;
  const restoreClock = installDeviceTimeZone(fixture, fault);
  const checks: Check[] = [];
  let observed = '';
  let faultFired = false;

  const arm = () => {
    if (fault.target === 'sqlite.getDb') controller.getDbThrows = true;
    else if (isPersistedCorruption(fault)) {
      controller.kv.set(ownerKey, kvValueUnderFault(fixture, fault));
      faultFired = true;
    } else if (fault.target.startsWith('sqlite.')) controller.armed = fault;
  };
  const disarm = () => {
    controller.getDbThrows = false;
    controller.armed = null;
  };
  const dbFaultFired = () =>
    faultFired ||
    controller.calls.some(call => call.outcome !== 'ok') ||
    controller.getDbThrowCount > 0;

  let scene: Scene | null = null;
  try {
    if (fault.phase !== 'second') arm();
    scene = await mountScene();

    // ---------------------------------------------- scenario branches --
    if (fault.target === 'navigation') {
      // Make the first load slow so the interaction races the request
      // (double-retry-press instead fails the first load outright).
      controller.armed =
        fault.detail === 'double-retry-press'
          ? {
              target: 'sqlite.shots',
              kind: 'reject',
              phase: 'first',
              detail: 'reject',
            }
          : {
              target: 'sqlite.shots',
              kind: 'slow',
              phase: 'first',
              detail: '2s',
            };
      await openCalendar(scene);
      faultFired = true;
      if (fault.detail === 'back-while-loading') {
        await goBack(scene);
        await advance(60_000);
        checks.push({
          name: 'unmount-mid-load-safe',
          ok:
            textOf(scene.renderer).includes('[stress-launch]') &&
            !hasTestId(scene.renderer, 'streak-hero') &&
            scene.boundaryErrors.length === 0,
          note: textOf(scene.renderer).slice(0, 80),
        });
        await openCalendar(scene);
        await advance(10_000);
      } else if (fault.detail === 'rapid-focus-toggle') {
        for (let i = 0; i < 6; i++) {
          await goBack(scene);
          await openCalendar(scene);
        }
        await advance(60_000);
        checks.push({
          name: 'refresh-count-bounded',
          ok: controller.loadCount <= 8,
          note: `${controller.loadCount} loads for 7 focuses`,
        });
      } else {
        // double-retry-press: the first load failed; hammer retry.
        await advance(5_000);
        checks.push(...checkErrorState(scene));
        const [retry] = hostPressables(scene.renderer, 'Try again');
        if (retry) {
          await act(async () => {
            retry.props.onPress();
            retry.props.onPress();
            retry.props.onPress();
          });
        }
        await advance(10_000);
      }
    } else if (fault.target === 'account') {
      controller.armed = {
        target: 'sqlite.shots',
        kind: 'slow',
        phase: 'first',
        detail: '2s',
      };
      await openCalendar(scene);
      faultFired = true;
      const other = '11111111-1111-4111-8111-111111111111';
      setActiveDataOwner(
        fault.detail === 'sign-out-while-loading'
          ? SIGNED_OUT_DATA_OWNER
          : other,
      );
      await advance(60_000);
      const state = useConsistencyStore.getState();
      const shown = heroNumbers(textOf(scene.renderer));
      const leaked =
        state.ownerKey === fixture.owner ||
        (state.snapshot !== null &&
          state.snapshot.totalActivities > 0 &&
          state.ownerKey !== fixture.owner) ||
        (truth !== null &&
          truth.currentStreak > 0 &&
          shown.streak === truth.currentStreak);
      checks.push({
        name: 'no-cross-owner-leak',
        ok: !leaked,
        note: `ownerKey=${String(state.ownerKey)} shown=${JSON.stringify(shown)}`,
      });
      // Sign the original owner back in and re-focus: must recover.
      setActiveDataOwner(fixture.owner);
      await goBack(scene);
      await openCalendar(scene);
      await advance(10_000);
    } else {
      await openCalendar(scene);
      if (fault.phase === 'second') {
        // Healthy first load, then the fault lands on the re-focus refresh.
        await advance(10_000);
        checks.push(
          ...checkHero(scene, healthyTruth).map(c => ({
            ...c,
            name: `pre-${c.name}`,
          })),
        );
        arm();
        await goBack(scene);
        await openCalendar(scene);
      }
      await advance(60_000);
      faultFired = fault.target.startsWith('sqlite.') ? dbFaultFired() : true;
    }

    // ------------------------------------------------- after 60s --------
    checks.push(...checkTree(scene, fetchSpy));
    const text = textOf(scene.renderer);
    const errorVisible = hasTestId(scene.renderer, 'streak-load-error');
    const heroVisible = hasTestId(scene.renderer, 'streak-hero');
    const state = useConsistencyStore.getState();

    if (fault.phase === 'second' && fault.target.startsWith('sqlite.')) {
      // A previously loaded snapshot is real data; it may stay on screen,
      // but it must still be the truth and a failed refresh must be visible.
      checks.push(...checkHero(scene, truth));
      if (isLoadFailure(fault)) {
        checks.push({
          name: 'failed-refresh-not-silent',
          ok: !(state.loadError && heroVisible && !errorVisible),
          note: `loadError=${state.loadError} heroVisible=${heroVisible} errorVisible=${errorVisible}`,
        });
      }
      observed = `second-load ${fault.kind}: loadError=${state.loadError}, hero still shown=${heroVisible}, error card=${errorVisible}`;
    } else if (isLedgerReadFailure(fault)) {
      // Documented degrade: streak derived from shots alone.
      checks.push(...checkHero(scene, shotsOnlyTruth));
      observed = `${fault.target} ${fault.kind} (${fault.phase}): hero=${heroVisible} error=${errorVisible} — shots-only degrade`;
    } else if (isHang(fault) && fault.target.startsWith('sqlite.')) {
      const pendingAfter60s = controller.pendingCount();
      // Probe whether ANY later refresh can reach the database.
      const loadsBefore = controller.loadCount;
      await goBack(scene);
      await openCalendar(scene);
      await advance(5_000);
      const queueJammed = controller.loadCount === loadsBefore;
      checks.push({
        name: 'no-silent-failure-after-60s',
        ok: errorVisible || !pendingAfter60s,
        note: `hung ${fault.target} for 60s: error card=${errorVisible}, hero=${heroVisible}, text="${text.slice(0, 90)}"`,
      });
      checks.push({
        name: 'refresh-queue-not-jammed',
        ok: !queueJammed,
        note: `loads before re-focus=${loadsBefore}, after=${controller.loadCount}`,
      });
      observed = `hung ${fault.target}: after 60s hero=${heroVisible} error=${errorVisible} snapshot=${state.snapshot ? 'set' : 'null'} loadError=${state.loadError}; re-focus reached db=${!queueJammed}`;
    } else if (isLoadFailure(fault) && fault.phase === 'always') {
      checks.push(...checkErrorState(scene));
      // Retry while still failing must keep the error state honest.
      await press(scene.renderer, 'Try again');
      await advance(5_000);
      checks.push(
        ...checkErrorState(scene).map(c => ({ ...c, name: `retry-${c.name}` })),
      );
      observed = `persistent ${fault.target} ${fault.kind}: error card=${errorVisible}`;
    } else if (isLoadFailure(fault) && fault.phase === 'first') {
      checks.push(...checkErrorState(scene));
      observed = `first-load ${fault.target} ${fault.kind}: error card=${errorVisible}`;
    } else if (fault.target === 'sqlite.kvWrite') {
      const wrote = controller.calls.some(c => c.op === 'kvWrite');
      faultFired = controller.calls.some(
        c => c.op === 'kvWrite' && c.outcome !== 'ok',
      );
      checks.push(...checkHero(scene, truth));
      checks.push({
        name: 'write-failure-does-not-hide-snapshot',
        ok: heroVisible && state.snapshot !== null,
        note: `write attempted=${wrote} fired=${faultFired}`,
      });
      observed = `kvWrite ${fault.kind}: write attempted=${wrote}, fault fired=${faultFired}, hero=${heroVisible}`;
    } else {
      // slow / timeout / malformed / partial / clock / fetch / native:
      // after 60s the screen must show real content.
      checks.push(...checkHero(scene, truth));
      observed = `${fault.target} ${fault.kind}(${fault.detail}): hero=${heroVisible} error=${errorVisible}`;
    }

    // ---------------------------------------------------- recovery -------
    // Dependencies heal; the user either taps "Try again" or comes back to
    // the screen. Either way the truth must be on screen afterwards.
    disarm();
    controller.releasePending();
    await flush();
    if (hasTestId(scene.renderer, 'streak-load-error')) {
      const pressed = await press(scene.renderer, 'Try again');
      await advance(10_000);
      checks.push({
        name: 'retry-recovers',
        ok: pressed && hasTestId(scene.renderer, 'streak-hero'),
        note: textOf(scene.renderer).slice(0, 100),
      });
    } else {
      await goBack(scene);
      await openCalendar(scene);
      await advance(10_000);
    }
    if (fault.target !== 'account') {
      checks.push(
        ...checkHero(scene, truth).map(c => ({
          ...c,
          name: `recovered-${c.name}`,
        })),
      );
    }

    // Back must always leave the screen.
    const backPressed = await press(scene.renderer, 'Back');
    checks.push({
      name: 'back-leaves-screen',
      ok:
        backPressed &&
        textOf(scene.renderer).includes('[stress-launch]') &&
        !hasTestId(scene.renderer, 'streak-hero') &&
        !hasTestId(scene.renderer, 'streak-load-error'),
      note: textOf(scene.renderer).slice(0, 60),
    });

    // ------------------------------------------- persisted state ---------
    const today = truth?.asOfDay ?? '';
    const ledger = checkLedgerIntegrity(
      persistedLedger,
      controller.kv.get(ownerKey),
      today,
    );
    checks.push({
      name: 'ledger-not-corrupted',
      ok: ledger.ok,
      note: ledger.reason,
    });
    checks.push({
      name: 'neighbour-ledger-untouched',
      ok: controller.kv.get(NEIGHBOUR_KEY) === NEIGHBOUR_LEDGER,
      note: '',
    });
    const foreignWrites = controller.calls.filter(
      c => c.op === 'kvWrite' && String(c.params[0]) !== ownerKey,
    );
    checks.push({
      name: 'no-foreign-key-writes',
      ok: foreignWrites.length === 0,
      note: foreignWrites.map(c => String(c.params[0])).join(','),
    });
    checks.push(
      ...checkTree(scene, fetchSpy).map(c => ({
        ...c,
        name: `final-${c.name}`,
      })),
    );
  } catch (error) {
    checks.push({
      name: 'no-harness-exception',
      ok: false,
      note:
        error instanceof Error
          ? `${error.message}\n${error.stack ?? ''}`
          : String(error),
    });
  } finally {
    disarm();
    controller.releasePending();
    await flush();
    if (scene) {
      await act(async () => {
        scene!.renderer.unmount();
      });
    }
    await flush();
    globalThis.fetch = previousFetch;
    restoreClock();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    resetStore();
    mockDbRef.current = null;
    jest.useRealTimers();
  }

  const broken = checks.filter(c => !c.ok);
  return {
    seed,
    fixture: {
      owner: fixture.owner,
      nowIso: fixture.nowIso,
      timeZone: fixture.timeZone,
      shots: fixture.shots.length,
      drills: fixture.drills.length,
      celebrated: Object.keys(fixture.celebrated),
    },
    fault,
    faultFired,
    outcome: broken.length === 0 ? 'HELD' : 'BROKEN',
    held: checks.filter(c => c.ok).map(c => c.name),
    broken: broken.map(c => `${c.name}: ${c.note}`),
    observed,
    durationMs: Date.now() - started,
  };
}

// ------------------------------------------------------- campaign -------

const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? 16));
const ONLY_SEED = process.env.STRESS_SEED
  ? Number(process.env.STRESS_SEED)
  : null;
const OUT = process.env.STRESS_OUT ?? null;
const results: IterationResult[] = [];

/** Deterministic sweep: every (target, kind, variant) the catalog knows. */
function catalogSeeds(): Array<{
  label: string;
  fixtureSeed: number;
  fault: Fault;
}> {
  const list: Array<{ label: string; fixtureSeed: number; fault: Fault }> = [];
  let n = 1000;
  const add = (fault: Fault) => {
    list.push({
      label: `${fault.target}/${fault.kind}/${fault.detail}/${fault.phase}`,
      fixtureSeed: n++,
      fault,
    });
  };
  for (const phase of ['first', 'always', 'second'] as const) {
    add({
      target: 'sqlite.getDb',
      kind: 'throw',
      phase,
      detail: 'getDb throws',
    });
    for (const target of ['sqlite.shots', 'sqlite.kvRead'] as const) {
      add({ target, kind: 'throw', phase, detail: 'throw' });
      add({ target, kind: 'reject', phase, detail: 'reject' });
      add({ target, kind: 'never', phase, detail: 'never' });
    }
  }
  for (const target of ['sqlite.shots', 'sqlite.kvRead'] as const) {
    add({ target, kind: 'slow', phase: 'first', detail: '4s' });
    add({ target, kind: 'timeout', phase: 'first', detail: '45s' });
    add({ target, kind: 'partial', phase: 'first', detail: 'partial' });
  }
  for (const variant of MALFORMED_SHOT_VARIANTS) {
    add({
      target: 'sqlite.shots',
      kind: 'malformed',
      phase: 'first',
      detail: variant,
    });
  }
  for (const variant of MALFORMED_KV_VARIANTS) {
    add({
      target: 'sqlite.kvRead',
      kind: 'malformed',
      phase: 'first',
      detail: variant,
    });
  }
  for (const kind of ['throw', 'reject', 'slow', 'timeout', 'never'] as const) {
    add({
      target: 'sqlite.kvWrite',
      kind,
      phase: 'first',
      detail: kind === 'slow' ? '3s' : kind === 'timeout' ? '45s' : kind,
    });
  }
  add({
    target: 'clock.timeZone',
    kind: 'throw',
    phase: 'always',
    detail: 'resolvedOptions throws',
  });
  for (const tz of BAD_TIME_ZONES) {
    add({
      target: 'clock.timeZone',
      kind: 'malformed',
      phase: 'always',
      detail: tz,
    });
  }
  for (const when of ODD_SYSTEM_TIMES) {
    add({
      target: 'clock.systemTime',
      kind: 'malformed',
      phase: 'always',
      detail: when,
    });
  }
  for (const detail of [
    'back-while-loading',
    'rapid-focus-toggle',
    'double-retry-press',
  ]) {
    add({ target: 'navigation', kind: 'partial', phase: 'first', detail });
  }
  for (const detail of [
    'sign-out-while-loading',
    'switch-owner-while-loading',
  ]) {
    add({ target: 'account', kind: 'partial', phase: 'first', detail });
  }
  for (const kind of ['throw', 'reject', 'never'] as const) {
    add({
      target: 'fetch',
      kind,
      phase: 'always',
      detail: 'global.fetch poisoned',
    });
  }
  add({
    target: 'native.unrelated',
    kind: 'throw',
    phase: 'always',
    detail: 'native modules throw on require',
  });
  return list;
}

const CATALOG = ONLY_SEED === null ? catalogSeeds() : [];
const RANDOM_SEEDS =
  ONLY_SEED !== null
    ? [ONLY_SEED]
    : Array.from({ length: ITER }, (_, i) => 20_000 + i);

function summarize(result: IterationResult): string {
  return `${result.outcome} seed=${result.seed} ${result.fault.target}/${result.fault.kind}/${result.fault.detail}/${result.fault.phase}\n  observed: ${result.observed}\n  broken: ${result.broken.join(' | ') || '-'}`;
}

describe('StreakCalendarScreen failure injection (real navigator + store)', () => {
  afterAll(() => {
    if (OUT) {
      const summary = {
        generatedAt: new Date().toISOString(),
        iterations: results.length,
        held: results.filter(r => r.outcome === 'HELD').length,
        broken: results.filter(r => r.outcome === 'BROKEN').length,
        faultsFired: results.filter(r => r.faultFired).length,
        results,
      };
      fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
    }
  });

  if (CATALOG.length > 0) {
    it.each(CATALOG.map(entry => [entry.label, entry]))(
      'catalog %s',
      async (_label, entry) => {
        const rng = makeRng(entry.fixtureSeed);
        const built = buildFixture(rng);
        const fixture =
          entry.fault.target === 'sqlite.kvWrite'
            ? withWritePath(built)
            : built;
        const result = await runScenario(
          entry.fixtureSeed,
          fixture,
          entry.fault,
          Date.now(),
        );
        results.push(result);
        if (result.broken.length > 0) throw new Error(summarize(result));
      },
    );
  }

  it.each(RANDOM_SEEDS)('seed %i', async seed => {
    const result = await runIteration(seed);
    results.push(result);
    if (result.broken.length > 0) throw new Error(summarize(result));
  });
});
