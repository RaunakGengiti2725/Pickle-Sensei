/**
 * HomeScreen failure-injection stress harness.
 *
 * Renders the REAL `RootNavigator` (real stores, hooks, navigation) with only
 * native modules and `fetch` replaced, then injects one fault set per
 * scenario into a dependency Home reaches — SQLite open/migrate/reads/writes,
 * the progress + rank APIs, the notification module, the clock/timezone,
 * navigation round trips, and native modules Home must never touch — and
 * checks the lens invariants against HomeScreen's contract:
 *
 *   recoverable  a failed primary load shows the ErrorState with "Try again"
 *                and the SAME retry control loads the court once the fault
 *                clears (a fault that persists must keep showing the error,
 *                never a spinner);
 *   no infinite  after 60 s of fake time the screen is not still on
 *   spinner      "Loading your court…" unless a retry control is visible;
 *   local first  the court (or its error) is up within the local latency
 *                budget — a slow or hung network must not gate local data;
 *   no fake      a failed primary read never renders court content, and no
 *   success      injected garbage row reaches the user as "NaN", "Invalid
 *                Date", "null", "undefined" or a fake-granted permission;
 *   no crash     no render/effect throws, no unhandled rejection;
 *   persisted    PRAGMA integrity_check is ok, local_shot rows are untouched
 *   state        and every KV value Home's path may write is well-formed.
 *
 * A failing `it` here IS a finding: the scenario id and seed in its name
 * replay it (see `replay` in the JSON table).
 *
 * Env:
 *   STRESS_ITER   extra seeded random fault combinations (default 8)
 *   STRESS_SEED   base seed (default 20260904); every scenario seed derives
 *                 from it plus the scenario id, so a table row replays with
 *                 STRESS_SEED=<base> STRESS_ONLY=<id>
 *   STRESS_ONLY   substring filter on scenario ids
 *   STRESS_OUT    JSON table path (default artifacts/stress/<file>.json)
 *
 * Runs on Node >= 22.13 (`node:sqlite`) like the other mobile SQLite suites.
 */
import {
  API_BASE_URL,
  auditPersisted,
  buildCatalog,
  classifySql,
  clockSkewInstant,
  createFaultController,
  createFetchFake,
  expectationFor,
  expectedLocalLatencyMs,
  findGarbageText,
  insertSeededShots,
  mulberry32,
  randomCatalogEntry,
  seedShots,
  snapshotPersisted,
  WEEK_CHART_KV_KEY,
  type CatalogEntry,
  type ClockSkewVariant,
  type Fault,
  type NodeSqliteDatabase,
  type PersistedSnapshot,
  type PoisonChannel,
  type ScenarioResult,
} from '../../test-support/stress/homeScreenFailureInjection';

// apps/mobile types only `jest` (no @types/node): declare the exact Node
// surface this harness drives, like the other node:sqlite suites do.
declare const require: (id: string) => unknown;
interface NodeProcess {
  env: Record<string, string | undefined>;
  version: string;
  cwd(): string;
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
}
const process = (globalThis as unknown as { process: NodeProcess }).process;

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => NodeSqliteDatabase;
};
const fs = require('fs') as {
  mkdirSync(path: string, options: { recursive: boolean }): void;
  writeFileSync(path: string, data: string): void;
};
const pathModule = require('path') as {
  join(...parts: string[]): string;
  dirname(path: string): string;
};

// ---------------------------------------------------------------------------
// Native seams (the ONLY mocks: native modules + fetch)
// ---------------------------------------------------------------------------

const mockCtl = createFaultController();

/**
 * A module whose every member records the access and, while its channel is
 * armed, throws. Home never reaches these modules; the poison proves it.
 */
function mockPoisonModule(channel: PoisonChannel): unknown {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_target, property) => {
      if (property === '__esModule') return true;
      if (property === 'then') return undefined;
      if (property === 'default') return proxy;
      const member = String(property);
      return () => {
        mockCtl.poisonCalls.push({ channel, member });
        if (mockCtl.faultFor(channel)?.mode === 'throw') {
          throw new Error(`poisoned ${channel}.${member}`);
        }
        return Promise.resolve(undefined);
      };
    },
  };
  const proxy: Record<string, unknown> = new Proxy({}, handler);
  return proxy;
}

jest.mock('@op-engineering/op-sqlite', () => {
  // The factory re-runs after every resetModules; it must close over the
  // controller in THIS file's scope (the `mock` prefix lets Jest allow it).
  const support =
    require('../../test-support/stress/homeScreenFailureInjection') as typeof import('../../test-support/stress/homeScreenFailureInjection');
  return support.createOpSqliteShim(mockCtl);
});
jest.mock('react-native-webview', () => ({ WebView: () => null }));
jest.mock('react-native-purchases', () =>
  mockPoisonModule('native.revenuecat'),
);
jest.mock('react-native-keychain', () => mockPoisonModule('native.keychain'));
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: jest.fn(), signIn: jest.fn(), signOut: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Scenario plumbing
// ---------------------------------------------------------------------------

type TestRendererModule = typeof import('react-test-renderer');
type Renderer = import('react-test-renderer').ReactTestRenderer;
type Instance = import('react-test-renderer').ReactTestInstance;

const BASE_NOW_ISO = '2026-09-04T18:00:00.000Z';
const SIGNED_IN_USER = '7f3a9c2e-5b1d-4e8f-9a6b-2c4d6e8f0a1b';
const STRESS_BASE_SEED = Number(process.env['STRESS_SEED'] ?? '20260904');
const STRESS_ITER = Number(process.env['STRESS_ITER'] ?? '8');
const STRESS_ONLY = process.env['STRESS_ONLY'] ?? '';
const SUITE_FILE =
  '__tests__/stress/homeScreen.failureInjection.stress.test.tsx';

const LOADING_TEXT = 'Loading your court…';
const ERROR_TITLE = 'Your court couldn’t load';
const RETRY_LABEL = 'Try again';
const COURT_TEXT_PREFIX = 'Ready when you are';

function hash32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seedFor(id: string): number {
  return hash32(`${STRESS_BASE_SEED}:${id}`);
}

function replayCommand(id: string): string {
  return `cd apps/mobile && STRESS_SEED=${STRESS_BASE_SEED} STRESS_ONLY='${id}' npx jest --ci ${SUITE_FILE}`;
}

interface FreshModules {
  React: typeof import('react');
  TestRenderer: TestRendererModule;
  RN: typeof import('react-native');
  accountScope: typeof import('../../src/data/accountScope');
  repository: typeof import('../../src/data/repository');
  db: typeof import('../../src/data/db');
  appStore: typeof import('../../src/state/appStore');
  apiSession: typeof import('../../src/account/apiSession');
  notificationStore: typeof import('../../src/notifications/notificationStore');
  consistencyStore: typeof import('../../src/consistency/store');
  notifee: typeof import('../../__mocks__/react-native-notify-kit');
  RootNavigator: typeof import('../../src/navigation/RootNavigator');
}

function requireFresh(RN: FreshModules['RN']): FreshModules {
  return {
    React: require('react') as FreshModules['React'],
    TestRenderer: require('react-test-renderer') as TestRendererModule,
    RN,
    accountScope:
      require('../../src/data/accountScope') as FreshModules['accountScope'],
    repository:
      require('../../src/data/repository') as FreshModules['repository'],
    db: require('../../src/data/db') as FreshModules['db'],
    appStore: require('../../src/state/appStore') as FreshModules['appStore'],
    apiSession:
      require('../../src/account/apiSession') as FreshModules['apiSession'],
    notificationStore:
      require('../../src/notifications/notificationStore') as FreshModules['notificationStore'],
    consistencyStore:
      require('../../src/consistency/store') as FreshModules['consistencyStore'],
    notifee: require('react-native-notify-kit') as FreshModules['notifee'],
    RootNavigator:
      require('../../src/navigation/RootNavigator') as FreshModules['RootNavigator'],
  };
}

function textsOf(renderer: Renderer, RN: FreshModules['RN']): string[] {
  const out: string[] = [];
  const flatten = (child: unknown): string => {
    if (child === null || child === undefined || typeof child === 'boolean') {
      return '';
    }
    if (Array.isArray(child)) return child.map(flatten).join('');
    if (typeof child === 'object') return '';
    return String(child);
  };
  for (const node of renderer.root.findAllByType(RN.Text)) {
    const text = flatten(node.props.children).trim();
    if (text) out.push(text);
  }
  return out;
}

function hasText(texts: readonly string[], needle: string): boolean {
  return texts.some(text => text.includes(needle));
}

function pressables(
  renderer: Renderer,
  predicate: (p: Record<string, unknown>) => boolean,
): Instance[] {
  return renderer.root.findAll(
    node =>
      typeof node.props['onPress'] === 'function' &&
      predicate(node.props as Record<string, unknown>),
  );
}

type Act = TestRendererModule['act'];

function pressByLabel(
  renderer: Renderer,
  label: string | RegExp,
  act: Act,
): boolean {
  const matches = pressables(renderer, props => {
    const value = props['accessibilityLabel'];
    return (
      typeof value === 'string' &&
      (typeof label === 'string' ? value === label : label.test(value))
    );
  });
  const target = matches[0];
  if (!target) return false;
  act(() => {
    (target.props['onPress'] as () => void)();
  });
  return true;
}

function pressByTestId(renderer: Renderer, testID: string, act: Act): boolean {
  const matches = pressables(renderer, props => props['testID'] === testID);
  const target = matches[0];
  if (!target) return false;
  act(() => {
    (target.props['onPress'] as () => void)();
  });
  return true;
}

function retryVisible(renderer: Renderer, RN: FreshModules['RN']): boolean {
  const texts = textsOf(renderer, RN);
  return (
    hasText(texts, ERROR_TITLE) &&
    pressables(renderer, props => props['accessibilityLabel'] === RETRY_LABEL)
      .length > 0
  );
}

type ScreenState = 'court' | 'error' | 'loading' | 'other';

function screenState(texts: readonly string[]): ScreenState {
  if (hasText(texts, ERROR_TITLE)) return 'error';
  if (texts.some(t => t.startsWith(COURT_TEXT_PREFIX))) return 'court';
  if (hasText(texts, LOADING_TEXT)) return 'loading';
  return 'other';
}

interface ClockPatch {
  restore(): void;
}

function patchTimezone(variant: string | undefined): ClockPatch {
  const RealDateTimeFormat = Intl.DateTimeFormat;
  const Patched = function (
    this: unknown,
    ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
  ) {
    if (args.length === 0 || (args[0] === undefined && args[1] === undefined)) {
      if (variant === 'throwOnConstruct') {
        throw new RangeError('Intl.DateTimeFormat: device zone unavailable');
      }
      const real = new RealDateTimeFormat();
      return {
        ...real,
        format: real.format.bind(real),
        resolvedOptions: () => ({
          ...real.resolvedOptions(),
          timeZone: 'Mars/Olympus_Mons',
        }),
      };
    }
    return new RealDateTimeFormat(...args);
  } as unknown as typeof Intl.DateTimeFormat;
  Object.defineProperty(Patched, 'supportedLocalesOf', {
    value: RealDateTimeFormat.supportedLocalesOf.bind(RealDateTimeFormat),
  });
  Intl.DateTimeFormat = Patched;
  return {
    restore() {
      Intl.DateTimeFormat = RealDateTimeFormat;
    },
  };
}

function installNativePoison(RN: FreshModules['RN']): void {
  const nativeModules = RN.NativeModules as Record<string, unknown>;
  nativeModules['PickleVideoCapture'] = mockPoisonModule('native.camera');
  nativeModules['PicklePoseVision'] = mockPoisonModule('native.vision');
  nativeModules['PickleAudioCoach'] = mockPoisonModule('native.tts');
}

function configureNotifee(
  notifee: FreshModules['notifee'],
  faults: readonly Fault[],
): void {
  const module = notifee.default as unknown as {
    getNotificationSettings: jest.Mock;
    requestPermission: jest.Mock;
    createTriggerNotification: jest.Mock;
  };
  const settings = faults.find(f => f.channel === 'notify.settings');
  if (settings?.mode === 'reject') {
    module.getNotificationSettings.mockImplementation(async () => {
      throw new Error('injected notify.settings reject');
    });
  } else if (settings?.mode === 'malformed') {
    module.getNotificationSettings.mockImplementation(async () => ({
      authorizationStatus: null,
    }));
  } else {
    // A device that has not answered the prompt yet: the priming card shows.
    module.getNotificationSettings.mockImplementation(async () => ({
      authorizationStatus: -1,
    }));
  }
  const request = faults.find(f => f.channel === 'notify.requestPermission');
  switch (request?.mode) {
    case 'reject':
      module.requestPermission.mockImplementation(async () => {
        throw new Error('injected notify.requestPermission reject');
      });
      break;
    case 'denied':
      module.requestPermission.mockImplementation(async () => ({
        authorizationStatus: 0,
      }));
      break;
    case 'slow':
      module.requestPermission.mockImplementation(
        () =>
          new Promise(resolve =>
            setTimeout(
              () => resolve({ authorizationStatus: 0 }),
              request.delayMs ?? 1000,
            ),
          ),
      );
      break;
    case 'malformed':
      module.requestPermission.mockImplementation(async () => ({
        authorizationStatus: null,
      }));
      break;
    default:
      module.requestPermission.mockImplementation(async () => ({
        authorizationStatus: 1,
      }));
  }
  const schedule = faults.find(f => f.channel === 'notify.schedule');
  if (schedule?.mode === 'reject') {
    module.createTriggerNotification.mockImplementation(async () => {
      throw new Error('injected notify.schedule reject');
    });
  }
}

const SETTLE_STEPS_MS = [
  0, 250, 500, 1000, 1500, 2000, 3000, 5000, 8000, 10_000, 14_000, 15_000,
  16_000, 20_000, 21_000, 30_000, 45_000, 60_000,
];

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

async function runScenario(
  entry: CatalogEntry,
  seed: number,
): Promise<ScenarioResult> {
  const started = Date.now();
  const rng = mulberry32(seed);
  const violations: string[] = [];
  const observations: string[] = [];
  const consoleErrors: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const consoleErrorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(a => String(a))
          .join(' ')
          .slice(0, 200),
      );
    });

  const skew = entry.faults.find(f => f.channel === 'clock.skew');
  const nowIso = skew
    ? clockSkewInstant((skew.variant ?? 'year2099') as ClockSkewVariant)
    : BASE_NOW_ISO;
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate'],
    now: new Date(nowIso),
  });
  jest.resetModules();

  mockCtl.clear();
  mockCtl.sqliteCalls.length = 0;
  mockCtl.fetchCalls.length = 0;
  mockCtl.poisonCalls.length = 0;
  const real = new DatabaseSync(':memory:');
  mockCtl.real = real;
  const restoreFetch = globalThis.fetch;
  globalThis.fetch = createFetchFake(
    mockCtl,
    BASE_NOW_ISO,
  ) as unknown as typeof fetch;

  const expectation = expectationFor(entry.faults);
  const armAtMount = !(
    entry.interaction === 'pullToRefresh' ||
    entry.interaction === 'streakCalendarRoundTrip' ||
    entry.interaction === 'openRecentResult'
  );
  const needsRecent = entry.interaction === 'openRecentResult';
  const wantsEmptyCourt = entry.faults.some(
    f => f.channel === 'fetch.progress' && f.mode === 'outOfRange',
  );
  const fixtureShots = wantsEmptyCourt
    ? 0
    : Math.max(needsRecent ? 1 : 0, rng.int(0, 12));

  let renderer = null as Renderer | null;
  let timezonePatch: ClockPatch | null = null;
  let finalState: ScenarioResult['finalState'] = 'other';
  let settledAtMs: number | null = null;
  let retryControlVisible = false;
  let recoveredAfterClear: boolean | null = null;
  let persistedBefore: PersistedSnapshot | null = null;
  let persistedAudit: ScenarioResult['persisted'] = null;
  let weekChartMayChange = false;
  let textsSample: string[] = [];

  // Native poison goes in BEFORE the app graph evaluates: modules such as
  // audio/tts.ts and camera/capture.ts read NativeModules at import time.
  const RN = require('react-native') as FreshModules['RN'];
  installNativePoison(RN);
  const mods = requireFresh(RN);
  const { React, TestRenderer } = mods;
  const act = TestRenderer.act;
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
    });
  };
  const advance = async (ms: number) => {
    if (ms > 0) {
      await act(async () => {
        jest.advanceTimersByTime(ms);
      });
    }
    await flush();
  };
  const texts = () => (renderer ? textsOf(renderer, RN) : []);

  try {
    // ---- bootstrap exactly like App.tsx's Gate (before any fault) ----------
    const owner =
      entry.session === 'signedIn'
        ? mods.accountScope.canonicalDataOwner(SIGNED_IN_USER)
        : mods.accountScope.GUEST_DATA_OWNER;
    mods.accountScope.setActiveDataOwner(owner);
    if (entry.session === 'signedIn') {
      mods.apiSession.establishApiSession({
        apiBaseUrl: API_BASE_URL,
        bearerToken: 'stress-bearer-not-a-secret',
        canonicalAppUserId: SIGNED_IN_USER,
        provider: 'apple',
      });
    }
    const db = mods.db.getDb();
    await mods.repository.setKv(
      db,
      mods.accountScope.profileKeyForOwner(owner),
      JSON.stringify({
        firstName: 'Sam',
        skillLevel: '3.5',
        handedness: 'right',
        goal: 'drives',
        biggestProblem: 'late contact',
        focusCheckpoint: 'preparation',
      }),
    );
    if (rng.chance(0.5))
      await mods.repository.setKv(db, WEEK_CHART_KV_KEY, 'reads');
    const shots = seedShots(
      mulberry32(seed ^ 0x9e3779b9),
      BASE_NOW_ISO,
      fixtureShots,
    );
    insertSeededShots(real, owner, shots);
    const newestShotLabel =
      [...shots]
        .sort((a, b) =>
          b.analysis.capturedAtIso.localeCompare(a.analysis.capturedAtIso),
        )[0]
        ?.analysis.shotType.replace(/_/g, ' ') ?? '';
    await mods.appStore.useAppStore.getState().hydrate();
    if (!mods.appStore.useAppStore.getState().profile) {
      throw new Error('fixture: profile did not hydrate');
    }
    // Re-open on next use so `sqlite.open` / `sqlite.migrate` faults are live.
    db.close();
    persistedBefore = snapshotPersisted(real);
    mockCtl.sqliteCalls.length = 0;

    // ---- arm ---------------------------------------------------------------
    configureNotifee(mods.notifee, entry.faults);
    const timezoneFault = entry.faults.find(
      f => f.channel === 'clock.timezone',
    );
    if (timezoneFault) timezonePatch = patchTimezone(timezoneFault.variant);
    if (armAtMount) mockCtl.arm(entry.faults);

    // Owner-scoped store bootstraps App.tsx starts alongside the navigator.
    void mods.notificationStore.useNotificationStore
      .getState()
      .hydrate({ expectedOwnerKey: owner });
    void mods.consistencyStore.useConsistencyStore.getState().hydrate();

    // ---- mount -------------------------------------------------------------
    const mountedAt = Date.now();
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(mods.RootNavigator.RootNavigator),
      );
    });
    await flush();

    const observeUntilSettled = async () => {
      let elapsed = 0;
      let firstSettled: number | null = null;
      for (const step of SETTLE_STEPS_MS) {
        await advance(step - elapsed);
        elapsed = step;
        const state = screenState(texts());
        if (state !== 'loading' && firstSettled === null) {
          firstSettled = Date.now() - mountedAt;
        }
      }
      return firstSettled;
    };

    if (armAtMount) {
      settledAtMs = await observeUntilSettled();
      const state = screenState(texts());
      retryControlVisible = renderer ? retryVisible(renderer, RN) : false;

      if (state === 'loading' && !retryControlVisible) {
        violations.push(
          'infinite-spinner: still "Loading your court…" after 60s with no retry/back control',
        );
      }
      const localBudget = expectedLocalLatencyMs(entry.faults) + 1000;
      if (settledAtMs !== null && settledAtMs > localBudget) {
        violations.push(
          `local-first: court/error appeared at ${settledAtMs}ms, budget ${localBudget}ms (network gated local data)`,
        );
      }

      if (expectation === 'error-retry') {
        if (state !== 'error') {
          violations.push(`recoverable: expected ErrorState, saw ${state}`);
        }
        if (!retryControlVisible)
          violations.push('recoverable: no "Try again" control');
        if (texts().some(t => t.startsWith(COURT_TEXT_PREFIX))) {
          violations.push(
            'fake-success: court content rendered beside a failed load',
          );
        }
        if (renderer && retryControlVisible) {
          // Retry while the fault persists: must land on the error again.
          pressByLabel(renderer, RETRY_LABEL, act);
          await advance(0);
          await advance(60_000);
          const afterRetry = screenState(texts());
          if (afterRetry !== 'error') {
            violations.push(
              `recoverable: retry under a persisting fault showed ${afterRetry}`,
            );
          }
          // Clear and retry: the same control must load the court.
          mockCtl.clear();
          pressByLabel(renderer, RETRY_LABEL, act);
          await advance(0);
          await advance(30_000);
          const recovered = screenState(texts()) === 'court';
          recoveredAfterClear = recovered;
          if (!recovered) {
            violations.push(
              `recoverable: after clearing faults retry showed ${screenState(texts())}`,
            );
          } else if (fixtureShots > 0) {
            if (!texts().some(t => t.toLowerCase().includes(newestShotLabel))) {
              violations.push(
                'fake-success: recovered court is missing the seeded reads',
              );
            }
          }
        }
      } else if (expectation === 'hang') {
        // The oracle says the hung read leaves nothing honest to show; the
        // invariant above already judged the spinner. Try clearing anyway.
        mockCtl.clear();
        await advance(5000);
        recoveredAfterClear = screenState(texts()) === 'court';
        if (!recoveredAfterClear) {
          observations.push(
            'hung local read: clearing the fault cannot recover without a remount',
          );
        }
      } else {
        if (state !== 'court') {
          violations.push(`recoverable: expected the court, saw ${state}`);
        }
        const garbage = findGarbageText(texts());
        if (garbage.length) {
          violations.push(
            `fake-success: garbage text reached the user: ${JSON.stringify(garbage.slice(0, 3))}`,
          );
        }
        if (
          state === 'court' &&
          fixtureShots > 0 &&
          !entry.faults.some(f => f.channel === 'sqlite.listShots')
        ) {
          if (!texts().some(t => t.toLowerCase().includes(newestShotLabel))) {
            violations.push(
              'fake-success: seeded reads missing from a healthy court',
            );
          }
        }
        if (entry.faults.some(f => f.channel === 'sqlite.listActivity')) {
          const consistency =
            mods.consistencyStore.useConsistencyStore.getState();
          if (
            consistency.loadError &&
            !texts().some(
              t =>
                /streak|consisten/i.test(t) &&
                /unavailable|couldn|try/i.test(t),
            )
          ) {
            observations.push(
              'consistency read failed: Home shows the 0-day streak with no indication (store.loadError=true)',
            );
          }
        }
        if (
          entry.faults.some(
            f => f.channel === 'fetch.progress' && f.mode === 'outOfRange',
          )
        ) {
          const scores = texts()
            .filter(t => /^\d+(\.\d+)?$/.test(t))
            .map(Number);
          const impossible = scores.filter(s => s > 10);
          if (impossible.length) {
            violations.push(
              `fake-success: impossible score rendered from server payload: ${impossible.join(',')}`,
            );
          }
        }
      }
    } else {
      // Interaction-armed scenarios: load a clean court first.
      settledAtMs = await observeUntilSettled();
      if (screenState(texts()) !== 'court') {
        violations.push(
          `fixture: clean court did not load (${screenState(texts())})`,
        );
      }
      mockCtl.arm(entry.faults);
    }

    // ---- interactions ------------------------------------------------------
    if (
      renderer &&
      violations.length === 0 &&
      screenState(texts()) === 'court'
    ) {
      switch (entry.interaction) {
        case 'toggleWeekChart': {
          weekChartMayChange = true;
          const target =
            (persistedBefore.kv[WEEK_CHART_KV_KEY] ?? 'scores') === 'reads'
              ? 'scores'
              : 'reads';
          const label =
            target === 'reads'
              ? 'Reads chart: scored reads per day'
              : 'Scores chart: every scored read at its score';
          if (!pressByLabel(renderer, label, act)) {
            observations.push(
              'week chart toggle not rendered (no comparable reads this week)',
            );
            break;
          }
          await advance(0);
          await advance(2000);
          const selected = renderer.root.findAll(
            n =>
              n.props['accessibilityLabel'] === label &&
              n.props['accessibilityState']?.selected === true,
          );
          if (selected.length === 0)
            violations.push(
              'recoverable: chart toggle did not apply on screen',
            );
          const persistedNow =
            snapshotPersisted(real).kv[WEEK_CHART_KV_KEY] ?? null;
          const writeFault = entry.faults.find(
            f => f.channel === 'sqlite.kv.set.weekChart',
          );
          if (writeFault) {
            if (
              persistedNow !== (persistedBefore.kv[WEEK_CHART_KV_KEY] ?? null)
            ) {
              violations.push(
                'persisted-state: chart preference changed although the write failed',
              );
            }
            observations.push(
              `chart write ${writeFault.mode}: UI toggled, stored value unchanged (${persistedNow ?? 'unset'})`,
            );
          } else if (persistedNow !== target) {
            violations.push(
              `persisted-state: chart preference is ${persistedNow}, expected ${target}`,
            );
          }
          break;
        }
        case 'pullToRefresh': {
          const control = renderer.root.findAllByType(RN.RefreshControl)[0];
          if (!control) {
            violations.push('recoverable: RefreshControl missing');
            break;
          }
          (control.props['onRefresh'] as () => void)();
          await advance(0);
          await advance(60_000);
          const after = screenState(texts());
          const stillRefreshing = renderer.root
            .findAllByType(RN.RefreshControl)
            .some(c => c.props['refreshing'] === true);
          if (stillRefreshing)
            violations.push(
              'infinite-spinner: RefreshControl still refreshing after 60s',
            );
          if (expectation === 'error-retry') {
            if (after !== 'error' || !retryVisible(renderer, RN)) {
              violations.push(
                `recoverable: failed refresh showed ${after} without a retry control`,
              );
            } else {
              mockCtl.clear();
              pressByLabel(renderer, RETRY_LABEL, act);
              await advance(0);
              await advance(30_000);
              recoveredAfterClear = screenState(texts()) === 'court';
              if (!recoveredAfterClear)
                violations.push(
                  'recoverable: retry after refresh failure did not load the court',
                );
            }
          } else if (after !== 'court') {
            violations.push(
              `recoverable: refresh under a secondary fault showed ${after}`,
            );
          }
          break;
        }
        case 'streakCalendarRoundTrip': {
          if (!pressByTestId(renderer, 'home-streak-badge', act)) {
            violations.push('navigation: streak badge missing');
            break;
          }
          await advance(0);
          await advance(2000);
          if (!hasText(texts(), 'Consistency')) {
            violations.push('navigation: StreakCalendar did not open');
            break;
          }
          if (!pressByLabel(renderer, 'Back', act)) {
            violations.push('navigation: StreakCalendar has no Back control');
            break;
          }
          await advance(0);
          await advance(60_000);
          const back = screenState(texts());
          if (expectation === 'error-retry') {
            if (back !== 'error' || !retryVisible(renderer, RN)) {
              violations.push(
                `recoverable: refocus under a fatal fault showed ${back} without retry`,
              );
            } else {
              mockCtl.clear();
              pressByLabel(renderer, RETRY_LABEL, act);
              await advance(0);
              await advance(30_000);
              recoveredAfterClear = screenState(texts()) === 'court';
              if (!recoveredAfterClear)
                violations.push(
                  'recoverable: retry after refocus failure did not load the court',
                );
            }
          } else if (back !== 'court') {
            violations.push(
              `navigation: returned to ${back} instead of the court`,
            );
          }
          break;
        }
        case 'openRecentResult': {
          if (!pressByLabel(renderer, /^Open .* result$/, act)) {
            violations.push('navigation: no recent read card to open');
            break;
          }
          await advance(0);
          await advance(60_000);
          const resultTexts = texts();
          const onHome = screenState(resultTexts) === 'court';
          const resultBack = pressables(
            renderer,
            p =>
              p['accessibilityLabel'] === 'Go back' ||
              p['accessibilityLabel'] === 'Back',
          );
          if (!onHome && resultBack.length === 0) {
            violations.push(
              'recoverable: Result under a read fault has no back control',
            );
            break;
          }
          if (!onHome) {
            act(() => {
              (resultBack[0]!.props['onPress'] as () => void)();
            });
            await advance(0);
            await advance(30_000);
          }
          if (screenState(texts()) !== 'court') {
            violations.push(
              `navigation: did not return to the court (${screenState(texts())})`,
            );
          }
          break;
        }
        case 'notificationTurnOn': {
          await advance(1000);
          if (!pressByLabel(renderer, 'Turn on practice reminders', act)) {
            violations.push('notification: priming card not visible');
            break;
          }
          await advance(0);
          const request = entry.faults.find(
            f => f.channel === 'notify.requestPermission',
          );
          if (request?.mode === 'slow') {
            const pendingTexts = texts();
            if (!hasText(pendingTexts, 'Asking…')) {
              violations.push(
                'notification: no pending state while the permission prompt is open',
              );
            }
            await advance(request.delayMs ?? 1000);
          }
          await advance(2000);
          const afterTexts = texts();
          const failureShown = hasText(
            afterTexts,
            'Reminders couldn’t be turned on',
          );
          const cardVisible =
            renderer.root.findAll(
              n => n.props['testID'] === 'notification-priming-card',
            ).length > 0;
          const prefs = mods.notificationStore.useNotificationStore.getState();
          if (request?.mode === 'reject') {
            if (!failureShown)
              violations.push(
                'silent-failure: permission failure not shown on the card',
              );
            if (prefs.prefs.enabled)
              violations.push(
                'fake-success: reminders enabled without permission',
              );
          } else if (request?.mode === 'denied' || request?.mode === 'slow') {
            // The OS said no: the card may hide (permission === 'denied') or
            // explain; it must not stay pending or pretend reminders are on.
            if (prefs.prefs.enabled)
              violations.push(
                'fake-success: reminders enabled after a denied prompt',
              );
            if (prefs.permission !== 'denied')
              violations.push(
                `silent-failure: permission recorded as ${prefs.permission} after denial`,
              );
            if (!failureShown && !cardVisible) {
              observations.push(
                'denied prompt: priming card disappears with no message (permission=denied hides it)',
              );
            }
          } else if (request?.mode === 'malformed') {
            if (prefs.prefs.enabled) {
              violations.push(
                'fake-success: malformed permission response treated as granted (reminders enabled)',
              );
            }
          } else if (entry.faults.some(f => f.channel === 'notify.schedule')) {
            if (
              prefs.prefs.enabled &&
              prefs.scheduleFailed &&
              !cardVisible &&
              !failureShown
            ) {
              observations.push(
                'schedule failed after grant: card dismissed as success; Home shows no indication (store.scheduleFailed=true)',
              );
            }
          }
          if (hasText(afterTexts, 'Asking…')) {
            violations.push('infinite-spinner: card stuck on "Asking…"');
          }
          break;
        }
        case 'notificationNotNow': {
          await advance(1000);
          if (!pressByLabel(renderer, 'Not now', act)) {
            violations.push('notification: priming card not visible');
            break;
          }
          await advance(0);
          await advance(2000);
          const cardVisible =
            renderer.root.findAll(
              n => n.props['testID'] === 'notification-priming-card',
            ).length > 0;
          if (cardVisible)
            violations.push('recoverable: "Not now" did not dismiss the card');
          if (
            mods.notificationStore.useNotificationStore.getState().persistFailed
          ) {
            observations.push(
              'dismissal persist failed: card hidden for this session only (store.persistFailed=true)',
            );
          }
          break;
        }
        default:
          break;
      }
    }

    // ---- final audit -------------------------------------------------------
    await advance(0);
    const finalTexts = texts();
    textsSample = finalTexts.slice(0, 80);
    const finalScreen = screenState(finalTexts);
    finalState = finalScreen;
    if (!retryControlVisible && renderer)
      retryControlVisible = retryVisible(renderer, RN);
    const garbage = findGarbageText(finalTexts);
    if (
      garbage.length &&
      !violations.some(v => v.startsWith('fake-success: garbage'))
    ) {
      violations.push(
        `fake-success: garbage text reached the user: ${JSON.stringify(garbage.slice(0, 3))}`,
      );
    }
    if (unhandled.length) {
      violations.push(
        `crash: ${unhandled.length} unhandled rejection(s): ${String(unhandled[0]).slice(0, 120)}`,
      );
    }
    for (const channel of [
      'native.camera',
      'native.vision',
      'native.tts',
      'native.revenuecat',
      'native.keychain',
    ] as const) {
      if (
        entry.faults.some(f => f.channel === channel) &&
        mockCtl.poisonCalls.some(c => c.channel === channel)
      ) {
        violations.push(`dependency-leak: Home invoked ${channel}`);
      }
    }
    persistedAudit = auditPersisted(persistedBefore, snapshotPersisted(real), {
      weekChartMayChange,
    });
    if (!persistedAudit.ok) {
      violations.push(`persisted-state: ${persistedAudit.problems.join('; ')}`);
    }
  } catch (error) {
    finalState = 'crashed';
    violations.push(
      `crash: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`.slice(
        0,
        300,
      ),
    );
  } finally {
    try {
      if (renderer) {
        const r: Renderer = renderer;
        await act(async () => {
          r.unmount();
        });
      }
    } catch {
      // Unmount failures are already covered by the crash violation above.
    }
    timezonePatch?.restore();
    globalThis.fetch = restoreFetch;
    mockCtl.clear();
    mockCtl.real = null;
    real.close();
    consoleErrorSpy.mockRestore();
    process.off('unhandledRejection', onUnhandled);
    jest.useRealTimers();
  }

  return {
    id: entry.id,
    seed,
    faults: entry.faults,
    session: entry.session,
    interaction: entry.interaction,
    fixtureShots,
    expectation,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    observations,
    settledAtMs,
    finalState,
    retryControlVisible,
    recoveredAfterClear,
    persisted: persistedAudit,
    sqliteCalls: mockCtl.sqliteCalls.length,
    fetchCalls: mockCtl.fetchCalls.length,
    poisonCalls: mockCtl.poisonCalls.length,
    consoleErrors: consoleErrors.slice(0, 5),
    textsSample,
    durationMs: Date.now() - started,
    replay: replayCommand(entry.id),
  };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

const catalog = buildCatalog();
const randomEntries: CatalogEntry[] = [];
for (let i = 0; i < STRESS_ITER; i++) {
  const seed = seedFor(`random:${i}`);
  randomEntries.push({
    ...randomCatalogEntry(seed, catalog),
    id: `random.${i}.${seed}`,
  });
}
const plan = [...catalog, ...randomEntries]
  .map(entry => ({
    entry,
    seed: entry.id.startsWith('random.')
      ? Number(entry.id.split('.')[2])
      : seedFor(entry.id),
  }))
  .filter(({ entry }) => !STRESS_ONLY || entry.id.includes(STRESS_ONLY));

const results: ScenarioResult[] = [];

afterAll(() => {
  const outPath =
    process.env['STRESS_OUT'] ??
    pathModule.join(
      process.cwd(),
      'artifacts',
      'stress',
      'homescreen-failure-injection.json',
    );
  const held = results.filter(r => r.outcome === 'HELD').length;
  const broken = results.filter(r => r.outcome === 'BROKEN');
  const table = {
    suite: SUITE_FILE,
    unit: 'apps/mobile/src/screens/HomeScreen.tsx',
    lens: 'failure-injection',
    node: process.version,
    baseSeed: STRESS_BASE_SEED,
    stressIter: STRESS_ITER,
    filter: STRESS_ONLY || null,
    planned: plan.length,
    executed: results.length,
    held,
    broken: broken.length,
    brokenIds: broken.map(r => `${r.id} (seed ${r.seed})`),
    channels: Object.fromEntries(
      Array.from(new Set(results.flatMap(r => r.faults.map(f => f.channel))))
        .sort()
        .map(channel => [
          channel,
          {
            executed: results.filter(r =>
              r.faults.some(f => f.channel === channel),
            ).length,
            broken: results.filter(
              r =>
                r.outcome === 'BROKEN' &&
                r.faults.some(f => f.channel === channel),
            ).length,
          },
        ]),
    ),
    results,
  };
  fs.mkdirSync(pathModule.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(table, null, 2));
});

describe('HomeScreen failure injection (real RootNavigator, mocked natives + fetch)', () => {
  it('classifies every SQL Home issues into a fault channel', () => {
    expect(
      classifySql('SELECT value FROM kv WHERE key = ?', [WEEK_CHART_KV_KEY]),
    ).toBe('sqlite.kv.get.weekChart');
    expect(
      classifySql(
        `SELECT payload FROM local_shot WHERE owner_key = ? AND source = 'real' ORDER BY captured_at DESC`,
        ['x'],
      ),
    ).toBe('sqlite.listFacts');
    expect(
      classifySql(
        `SELECT payload FROM local_shot WHERE owner_key = ? AND id = ? AND source = 'real'`,
        ['x', 'id'],
      ),
    ).toBe('sqlite.other');
    expect(
      classifySql(
        `SELECT id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite
         FROM local_shot WHERE owner_key = ? AND source = 'real' ORDER BY captured_at DESC LIMIT ?`,
        ['x', 250],
      ),
    ).toBe('sqlite.listShots');
    expect(
      classifySql(
        `SELECT id FROM local_shot WHERE owner_key = ? ORDER BY captured_at ASC`,
        ['x'],
      ),
    ).toBe('sqlite.listActivity');
    expect(
      classifySql('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', [
        WEEK_CHART_KV_KEY,
        'reads',
      ]),
    ).toBe('sqlite.kv.set.weekChart');
  });

  it('plans at least 60 injected-fault scenarios', () => {
    expect(catalog.length).toBeGreaterThanOrEqual(60);
  });

  for (const { entry, seed } of plan) {
    it(`${entry.id} [seed ${seed}] — ${entry.faults.map(f => `${f.channel}:${f.mode}`).join(' + ')}`, async () => {
      const result = await runScenario(entry, seed);
      results.push(result);
      expect(result.violations).toEqual([]);
    }, 60_000);
  }
});
