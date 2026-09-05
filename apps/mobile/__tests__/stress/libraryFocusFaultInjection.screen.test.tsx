import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { LocalDb } from '../../src/data/db';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import {
  DEFAULT_ITERATIONS,
  HANG_BUDGET_MS,
  MALFORMED_CLASSES,
  type MalformedClass,
  type PayloadShape,
  referenceFocusPossible,
  type FaultMode,
  type ScenarioRow,
  chance,
  deferred,
  dinkFocusFacts,
  int,
  malformedRow,
  mulberry32,
  pick,
  referenceKept,
  seedList,
  validRow,
  writeCampaignReport,
} from '../../test-support/stress/libraryFocusFaultKit';

/**
 * mod-library-focus · failure-injection · the CONSUMING FLOW.
 *
 * `computeLibraryFocus` is pure; the only place it meets the outside world is
 * `DrillLibraryScreen`, which reads local evidence (`getDb` +
 * `listScoredCheckpointFacts`) and the drill catalog (`createTrainingApi` →
 * `fetch`). This suite renders the REAL screen with the REAL training API
 * and the REAL repository parser, and injects faults one layer below:
 *
 *   sqlite.getDb                 throw · undefined · object without execute
 *   sqlite.execute (scripted db) throw · reject · timeout · never · slow ·
 *                                malformed rows · partial rows
 *   fetch.catalog (globalThis)   throw · reject · timeout · never · slow ·
 *                                malformed JSON / items / status · partial
 *   session (Keychain-derived)   null · blank token · blank base URL
 *   clock                        hostile system time around the reads
 *   navigation                   navigate/goBack that throw
 *
 * After every injection the fake clock is advanced by HANG_BUDGET_MS (60 s)
 * and these invariants are checked:
 *
 *   S1 no crash                the tree renders (a render-time throw is BROKEN)
 *   S2 no infinite spinner     no LoadingState is still mounted after 60 s
 *   S3 visible recovery        a failed catalog shows "Try again"; a failed
 *                              focus read leaves pull-to-refresh reachable
 *   S4 no fake success         no focus card without a valid computed focus,
 *                              no drill card without a parsed catalog, no
 *                              non-finite score rendered
 *   S5 recovery works          healing the dependency and using the visible
 *                              control reaches the healthy state
 *   S6 no persistence writes   the read paths never issue a write statement
 *   S7 no silent failure       a failed local read is distinguishable from
 *                              "not enough evidence yet"
 *
 * Camera, Vision, TTS, RevenueCat and permissions are NOT dependencies of
 * this module or of this screen (see the import list of
 * DrillLibraryScreen.tsx); they are recorded as `n/a` in the report rather
 * than claimed as tested.
 *
 * Replay one seed:
 *   STRESS_SEED=<n> npx jest --ci __tests__/stress/libraryFocusFaultInjection.screen
 * Bigger campaign:
 *   STRESS_ITER=1000 npx jest --ci __tests__/stress/libraryFocusFaultInjection.screen
 */

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

jest.mock('react-native-webview', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

// Navigation is scripted per scenario: the default is a recording stub, the
// `navigation` dependency swaps in a throwing one.
const mockNavigation = {
  goBack: jest.fn(),
  navigate: jest.fn(),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
}));

// The SQLite binding does not exist under jest. `getDb` is scripted per
// scenario and returns a db whose `execute` is the fault surface.
const mockGetDb = jest.fn<unknown, []>();
jest.mock('../../src/data/db', () => ({ getDb: () => mockGetDb() }));

// The repository stays REAL: the scripted db is what fails.
import { listScoredCheckpointFacts } from '../../src/data/repository';

import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';

// ---------------------------------------------------------------------------
// scripted dependencies

interface ScriptedDb extends LocalDb {
  writes: string[];
  sqlLog: string[];
}

type Rows = Record<string, unknown>[];

type ExecutePlan =
  | { kind: 'rows'; rows: Rows }
  | { kind: 'throw' }
  | { kind: 'reject' }
  | { kind: 'never' }
  | { kind: 'delay'; ms: number; rows: Rows };

function scriptedDb(plan: ExecutePlan): ScriptedDb {
  const writes: string[] = [];
  const sqlLog: string[] = [];
  return {
    writes,
    sqlLog,
    execute(sql) {
      sqlLog.push(sql);
      if (!/^\s*SELECT\b/i.test(sql)) writes.push(sql);
      switch (plan.kind) {
        case 'rows':
          return Promise.resolve({ rows: plan.rows });
        case 'throw':
          throw new Error('SQLITE_IOERR: disk I/O error');
        case 'reject':
          return Promise.reject(new Error('SQLITE_BUSY: database is locked'));
        case 'never':
          return deferred<{ rows: Rows }>().promise;
        case 'delay':
          return new Promise(resolve =>
            setTimeout(() => resolve({ rows: plan.rows }), plan.ms),
          );
      }
    },
    close() {},
  };
}

interface FetchScript {
  calls: number;
  impl: (url: string) => Promise<Response>;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const CATALOG_ITEM = {
  id: '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17',
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description: 'Land four consecutive cross-court dinks per kitchen zone.',
  coach_name: 'Pickle Sensei Training Library',
  equipment: ['paddle', 'balls'],
  difficulty_min: '2.0',
  difficulty_max: '3.5',
  families: ['dink'],
  validation_state: 'PUBLISHED',
  saved: false,
};

const HEALTHY_CATALOG = jsonResponse(200, { items: [CATALOG_ITEM] });

type FetchFault =
  | 'healthy'
  | 'throw'
  | 'reject'
  | 'never'
  | 'slow'
  | 'timeout'
  | 'malformed-not-object'
  | 'malformed-items-not-array'
  | 'malformed-item-missing-fields'
  | 'malformed-json-rejects'
  | 'malformed-500-bad-body'
  | 'malformed-500-json-error'
  | 'malformed-429'
  | 'malformed-401'
  | 'malformed-204'
  | 'partial-one-bad-item';

const FETCH_FAULTS: readonly FetchFault[] = [
  'throw',
  'reject',
  'never',
  'slow',
  'timeout',
  'malformed-not-object',
  'malformed-items-not-array',
  'malformed-item-missing-fields',
  'malformed-json-rejects',
  'malformed-500-bad-body',
  'malformed-500-json-error',
  'malformed-429',
  'malformed-401',
  'malformed-204',
  'partial-one-bad-item',
];

function fetchFaultMode(fault: FetchFault): FaultMode | 'healthy' {
  if (fault === 'healthy') return 'healthy';
  if (fault.startsWith('malformed')) return 'malformed';
  if (fault.startsWith('partial')) return 'partial';
  return fault as FaultMode;
}

/** A catalog fetch that fails for `failures` calls, then heals. */
function scriptedFetch(
  fault: FetchFault,
  slowMs: number,
  failures = 1,
): FetchScript {
  const script: FetchScript = {
    calls: 0,
    impl: () => Promise.resolve(HEALTHY_CATALOG),
  };
  script.impl = () => {
    script.calls += 1;
    if (script.calls > failures) return Promise.resolve(HEALTHY_CATALOG);
    switch (fault) {
      case 'healthy':
        return Promise.resolve(HEALTHY_CATALOG);
      case 'throw':
        throw new TypeError('Network request failed');
      case 'reject':
        return Promise.reject(new TypeError('Network request failed'));
      case 'never':
        return deferred<Response>().promise;
      case 'slow':
        return new Promise(resolve =>
          setTimeout(() => resolve(HEALTHY_CATALOG), slowMs),
        );
      case 'timeout':
        return new Promise(resolve =>
          setTimeout(() => resolve(HEALTHY_CATALOG), HANG_BUDGET_MS + slowMs),
        );
      case 'malformed-not-object':
        return Promise.resolve(jsonResponse(200, 'items'));
      case 'malformed-items-not-array':
        return Promise.resolve(jsonResponse(200, { items: { length: 1 } }));
      case 'malformed-item-missing-fields':
        return Promise.resolve(
          jsonResponse(200, { items: [{ slug: 'x', saved: false }] }),
        );
      case 'malformed-json-rejects':
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.reject(new SyntaxError('Unexpected token <')),
        } as unknown as Response);
      case 'malformed-500-bad-body':
        return Promise.resolve(jsonResponse(500, '<html>Bad gateway</html>'));
      case 'malformed-500-json-error':
        return Promise.resolve(
          jsonResponse(500, {
            error: { code: 'training.upstream', message: 'Upstream failed.' },
          }),
        );
      case 'malformed-429':
        return Promise.resolve(
          jsonResponse(429, {
            error: { code: 'rate_limited', message: 'Slow down.' },
          }),
        );
      case 'malformed-401':
        return Promise.resolve(jsonResponse(401, {}));
      case 'malformed-204':
        return Promise.resolve(jsonResponse(204, null));
      case 'partial-one-bad-item':
        return Promise.resolve(
          jsonResponse(200, { items: [CATALOG_ITEM, { saved: 'yes' }] }),
        );
    }
  };
  return script;
}

// ---------------------------------------------------------------------------
// tree helpers

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  const json = renderer.toJSON();
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const element = node as { children?: unknown[] };
    element.children?.forEach(walk);
  };
  walk(json);
  return out.join('\n');
}

function hasTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
): boolean {
  return renderer.root.findAll(n => n.props.testID === testID).length > 0;
}

function loadingMounted(renderer: TestRenderer.ReactTestRenderer): boolean {
  return (
    renderer.root.findAll(
      n =>
        typeof n.props.accessibilityLabel === 'string' &&
        n.props.accessibilityLabel.startsWith('Loading the drill catalog'),
    ).length > 0
  );
}

function pressable(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): TestRenderer.ReactTestInstance | null {
  const hits = renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      n.props.accessibilityLabel === label,
  );
  return hits[0] ?? null;
}

function refreshControl(
  renderer: TestRenderer.ReactTestRenderer,
): TestRenderer.ReactTestInstance | null {
  const hits = renderer.root.findAll(
    n => typeof n.props.onRefresh === 'function',
  );
  return hits[0] ?? null;
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

// ---------------------------------------------------------------------------
// scenario model

type Dependency =
  | 'sqlite.getDb'
  | 'sqlite.execute'
  | 'fetch.catalog'
  | 'session.keychain'
  | 'clock'
  | 'navigation';

interface Scenario {
  seed: number;
  dependency: Dependency;
  fault: FaultMode;
  detail: string;
  db: ExecutePlan | 'getDb-throw' | 'getDb-undefined' | 'getDb-no-execute';
  fetch: FetchFault;
  slowMs: number;
  session: 'ok' | 'null' | 'blank-token' | 'blank-url';
  clock: number | null;
  navigationThrows: boolean;
  expectFocusPossible: boolean;
  malformedClasses: MalformedClass[];
}

function pickMalformedRows(
  rng: () => number,
  count: number,
  concentrated: MalformedClass | null,
): { rows: Rows; classes: MalformedClass[] } {
  const rows: Rows = [];
  const classes: MalformedClass[] = [];
  for (let i = 0; i < count; i += 1) {
    if (chance(rng, 0.6)) {
      const cls = concentrated ?? pick(rng, MALFORMED_CLASSES);
      classes.push(cls);
      rows.push(malformedRow(rng, cls).row);
    } else {
      rows.push(validRow(rng).row);
    }
  }
  if (classes.length === 0) {
    const cls = concentrated ?? pick(rng, MALFORMED_CLASSES);
    classes.push(cls);
    rows[0] = malformedRow(rng, cls).row;
  }
  return { rows, classes };
}

/** Rows that decode to a dink focus through the real repository. */
function focusRows(): Rows {
  return dinkFocusFacts().map(fact => ({
    payload: JSON.stringify({
      id: fact.id,
      shotType: fact.shotType,
      capturedAtIso: fact.capturedAt,
      source: 'real',
      resultKind: 'scored',
      checkpoints: fact.checkpoints,
    }),
  }));
}

function buildScenario(seed: number): Scenario {
  const rng = mulberry32(seed);
  const dependency = pick(rng, [
    'sqlite.getDb',
    'sqlite.execute',
    'sqlite.execute',
    'sqlite.execute',
    'fetch.catalog',
    'fetch.catalog',
    'fetch.catalog',
    'session.keychain',
    'clock',
    'navigation',
  ] as const);
  const slowMs = int(rng, 250, HANG_BUDGET_MS - 1000);
  const base: Scenario = {
    seed,
    dependency,
    fault: 'throw',
    detail: '',
    db: { kind: 'rows', rows: focusRows() },
    fetch: 'healthy',
    slowMs,
    session: 'ok',
    clock: null,
    navigationThrows: false,
    expectFocusPossible: true,
    malformedClasses: [],
  };
  switch (dependency) {
    case 'sqlite.getDb': {
      const variant = pick(rng, [
        'getDb-throw',
        'getDb-undefined',
        'getDb-no-execute',
      ] as const);
      return {
        ...base,
        db: variant,
        fault:
          variant === 'getDb-throw'
            ? 'throw'
            : variant === 'getDb-undefined'
              ? 'malformed'
              : 'partial',
        detail: variant,
        expectFocusPossible: false,
      };
    }
    case 'sqlite.execute': {
      const fault = pick(rng, [
        'throw',
        'reject',
        'timeout',
        'never',
        'slow',
        'malformed',
        'partial',
      ] as const);
      if (fault === 'malformed') {
        const concentrated = chance(rng, 0.34)
          ? pick(rng, MALFORMED_CLASSES)
          : null;
        const { rows, classes } = pickMalformedRows(
          rng,
          int(rng, 1, 12),
          concentrated,
        );
        const kept = rows
          .map(row => referenceKept(row))
          .filter((p): p is PayloadShape => p !== null);
        return {
          ...base,
          fault,
          db: { kind: 'rows', rows },
          detail: `rows=${rows.length} classes=${[...new Set(classes)].sort().join(',')}`,
          malformedClasses: classes,
          expectFocusPossible: referenceFocusPossible(kept),
        };
      }
      if (fault === 'partial') {
        const rows = focusRows();
        rows[int(rng, 0, rows.length - 1)] = { id: 'partial-row' };
        return {
          ...base,
          fault,
          db: { kind: 'rows', rows },
          detail: 'one row missing the payload column',
          expectFocusPossible: false,
        };
      }
      if (fault === 'throw') {
        return {
          ...base,
          fault,
          db: { kind: 'throw' },
          detail: 'execute throws synchronously',
          expectFocusPossible: false,
        };
      }
      if (fault === 'reject') {
        return {
          ...base,
          fault,
          db: { kind: 'reject' },
          detail: 'execute rejects',
          expectFocusPossible: false,
        };
      }
      if (fault === 'never') {
        return {
          ...base,
          fault,
          db: { kind: 'never' },
          detail: 'execute never settles',
          expectFocusPossible: false,
        };
      }
      if (fault === 'timeout') {
        return {
          ...base,
          fault,
          db: { kind: 'delay', ms: HANG_BUDGET_MS + slowMs, rows: focusRows() },
          detail: `execute settles after ${HANG_BUDGET_MS + slowMs}ms (> budget)`,
          expectFocusPossible: false,
        };
      }
      return {
        ...base,
        fault,
        db: { kind: 'delay', ms: slowMs, rows: focusRows() },
        detail: `execute settles after ${slowMs}ms`,
        expectFocusPossible: true,
      };
    }
    case 'fetch.catalog': {
      const fetchFault = pick(rng, FETCH_FAULTS);
      const mode = fetchFaultMode(fetchFault);
      return {
        ...base,
        fault: mode === 'healthy' ? 'slow' : mode,
        fetch: fetchFault,
        detail: fetchFault,
      };
    }
    case 'session.keychain': {
      const variant = pick(rng, ['null', 'blank-token', 'blank-url'] as const);
      return {
        ...base,
        fault: variant === 'null' ? 'reject' : 'partial',
        session: variant,
        detail: `session ${variant}`,
      };
    }
    case 'clock': {
      const clock = pick(rng, [
        0,
        -1,
        Date.UTC(1970, 0, 1),
        Date.UTC(2099, 11, 31),
        Date.UTC(2038, 0, 19, 3, 14, 7),
        8.64e15,
      ]);
      return {
        ...base,
        fault: 'malformed',
        clock,
        detail: `system time ${clock}`,
      };
    }
    case 'navigation':
      return {
        ...base,
        fault: 'throw',
        navigationThrows: true,
        detail: 'navigate/goBack throw',
      };
  }
}

// ---------------------------------------------------------------------------
// one scenario run

interface RunResult {
  row: ScenarioRow;
  renderError: string | null;
}

async function runScenario(scenario: Scenario): Promise<RunResult> {
  const violations: string[] = [];
  const notes: string[] = [];
  let db: ScriptedDb | null = null;

  if (scenario.clock !== null) jest.setSystemTime(scenario.clock);

  switch (scenario.db) {
    case 'getDb-throw':
      mockGetDb.mockImplementation(() => {
        throw new Error('SQLITE_CANTOPEN: unable to open database file');
      });
      break;
    case 'getDb-undefined':
      mockGetDb.mockImplementation(() => undefined);
      break;
    case 'getDb-no-execute':
      mockGetDb.mockImplementation(() => ({}));
      break;
    default: {
      db = scriptedDb(scenario.db);
      const handle = db;
      mockGetDb.mockImplementation(() => handle);
    }
  }
  const fetchScript = scriptedFetch(scenario.fetch, scenario.slowMs);
  (globalThis as { fetch: unknown }).fetch = (url: string) =>
    fetchScript.impl(url);

  if (scenario.session === 'null') clearApiSession();
  else {
    establishApiSession({
      apiBaseUrl: scenario.session === 'blank-url' ? '   ' : 'https://api.test',
      bearerToken: scenario.session === 'blank-token' ? '' : 'token-1',
      canonicalAppUserId: 'user-1',
      provider: 'apple',
    });
  }

  mockNavigation.navigate.mockReset();
  mockNavigation.goBack.mockReset();
  if (scenario.navigationThrows) {
    mockNavigation.navigate.mockImplementation(() => {
      throw new Error('navigation: no navigator');
    });
    mockNavigation.goBack.mockImplementation(() => {
      throw new Error('navigation: no navigator');
    });
  }

  let renderer: TestRenderer.ReactTestRenderer | null = null;
  let renderError: string | null = null;
  const consoleError = jest
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  try {
    await act(async () => {
      renderer = TestRenderer.create(<DrillLibraryScreen />);
    });
    await settle(0);
    await settle(HANG_BUDGET_MS);
  } catch (error) {
    renderError = error instanceof Error ? error.message : String(error);
  }
  consoleError.mockRestore();

  const fetchMode = fetchFaultMode(scenario.fetch);
  const catalogShouldHaveLoaded =
    scenario.session === 'ok' &&
    (fetchMode === 'healthy' || fetchMode === 'slow');
  const catalogHung = fetchMode === 'never' || fetchMode === 'timeout';

  if (renderError !== null) {
    violations.push(`S1 render threw: ${renderError}`);
  } else if (renderer !== null) {
    const r = renderer as TestRenderer.ReactTestRenderer;
    const text = allText(r);
    const focusCard = hasTestId(r, 'library-focus');
    const hint = hasTestId(r, 'library-focus-hint');
    const drillCard = hasTestId(r, 'drill-card-dink-target-ladder');
    const retry = pressable(r, 'Try again');
    const connect = pressable(r, 'Connect account');
    const refresh = refreshControl(r);
    const spinner = loadingMounted(r);

    // S2 — no infinite spinner after the hang budget.
    if (spinner) violations.push('S2 LoadingState still mounted after 60s');

    // S4 — no fake success.
    if (/\bInfinity\b|\bNaN\b/.test(text)) {
      violations.push('S4 non-finite score rendered');
    }
    if (focusCard && !scenario.expectFocusPossible) {
      violations.push('S4 focus card rendered without valid evidence');
    }
    if (drillCard && !catalogShouldHaveLoaded) {
      violations.push('S4 drill card rendered although catalog failed');
    }

    // S3 — visible recovery control when the catalog failed.
    if (scenario.session !== 'ok') {
      if (!connect && !retry) {
        violations.push('S3 no Connect account / Try again for bad session');
      } else {
        notes.push(connect ? 'connect-account visible' : 'try-again visible');
      }
    } else if (!catalogShouldHaveLoaded && !catalogHung) {
      if (!retry) violations.push('S3 no Try again after catalog failure');
      else notes.push('try-again visible');
    } else if (catalogHung) {
      if (!retry && !refresh) {
        violations.push('S3 no retry/back control while catalog hangs');
      }
    } else if (!refresh) {
      violations.push('S3 no pull-to-refresh on the loaded catalog');
    }

    // S7 — a failed local read must not be indistinguishable from thin evidence.
    const focusReadFailed =
      scenario.dependency === 'sqlite.getDb' ||
      (scenario.dependency === 'sqlite.execute' &&
        (scenario.fault === 'throw' || scenario.fault === 'reject'));
    if (focusReadFailed && catalogShouldHaveLoaded && hint && !focusCard) {
      violations.push(
        'S7 failed evidence read shows the "after two scored analyses" hint',
      );
    }

    // S5 — recovery: heal and use the visible control.
    if (scenario.session === 'ok' && !catalogShouldHaveLoaded && retry) {
      fetchScript.impl = () => Promise.resolve(HEALTHY_CATALOG);
      try {
        await act(async () => {
          retry.props.onPress();
        });
        await settle(0);
        if (!hasTestId(r, 'drill-card-dink-target-ladder')) {
          violations.push('S5 Try again did not recover the catalog');
        } else notes.push('try-again recovered catalog');
      } catch (error) {
        violations.push(
          `S5 retry threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (
      catalogShouldHaveLoaded &&
      !scenario.expectFocusPossible &&
      scenario.dependency !== 'sqlite.execute'
    ) {
      // getDb failed: heal it and pull to refresh.
      const healthy = scriptedDb({ kind: 'rows', rows: focusRows() });
      mockGetDb.mockImplementation(() => healthy);
      const control = refreshControl(r);
      if (control) {
        try {
          await act(async () => {
            control.props.onRefresh();
          });
          await settle(0);
          if (!hasTestId(r, 'library-focus')) {
            violations.push('S5 refresh after healed getDb did not show focus');
          } else notes.push('refresh recovered focus');
        } catch (error) {
          violations.push(
            `S5 refresh threw: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    if (
      catalogShouldHaveLoaded &&
      scenario.dependency === 'sqlite.execute' &&
      (scenario.fault === 'throw' ||
        scenario.fault === 'reject' ||
        scenario.fault === 'partial')
    ) {
      const healthy = scriptedDb({ kind: 'rows', rows: focusRows() });
      mockGetDb.mockImplementation(() => healthy);
      const control = refreshControl(r);
      if (control) {
        try {
          await act(async () => {
            control.props.onRefresh();
          });
          await settle(0);
          if (!hasTestId(r, 'library-focus')) {
            violations.push(
              'S5 refresh after healed execute did not show focus',
            );
          } else notes.push('refresh recovered focus');
        } catch (error) {
          violations.push(
            `S5 refresh threw: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // Navigation: pressing Connect account with a throwing navigator.
    if (scenario.navigationThrows && connect) {
      try {
        await act(async () => {
          connect.props.onPress();
        });
      } catch (error) {
        violations.push(
          `S1 navigation throw escaped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Expected-healthy scenarios must actually reach the healthy state.
    if (
      scenario.expectFocusPossible &&
      scenario.fault !== 'malformed' &&
      catalogShouldHaveLoaded &&
      scenario.dependency !== 'session.keychain' &&
      scenario.fetch === 'healthy' &&
      scenario.db !== 'getDb-throw' &&
      !focusCard
    ) {
      violations.push('S5 healthy evidence did not produce a focus card');
    }
    if (catalogShouldHaveLoaded && !drillCard && !retry) {
      violations.push('S5 healthy catalog did not render a drill card');
    }

    try {
      await act(async () => {
        r.unmount();
      });
    } catch (error) {
      violations.push(
        `S1 unmount threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // S6 — the read path never writes.
  if (db && db.writes.length > 0) {
    violations.push(
      `S6 write statements on read path: ${db.writes.join(' | ')}`,
    );
  }

  const defect = attribute(scenario, violations);
  const row: ScenarioRow = {
    seed: scenario.seed,
    dependency: scenario.dependency,
    fault: scenario.fault,
    detail: [scenario.detail, ...notes].join(' · '),
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    defect,
    replay: `cd apps/mobile && STRESS_SEED=${scenario.seed} npx jest --ci __tests__/stress/libraryFocusFaultInjection.screen`,
  };
  return { row, renderError };
}

/** Pins every BROKEN row to a known defect class or leaves it unattributed. */
function attribute(scenario: Scenario, violations: string[]): string | null {
  if (violations.length === 0) return null;
  const defects: string[] = [];
  const fetchMode = fetchFaultMode(scenario.fetch);
  if (
    (fetchMode === 'never' || fetchMode === 'timeout') &&
    violations.some(v => v.startsWith('S2'))
  ) {
    defects.push('D4-catalog-fetch-no-timeout-infinite-loading');
  }
  if (violations.some(v => v.startsWith('S7'))) {
    defects.push('D5-focus-read-failure-indistinguishable-from-thin-evidence');
  }
  if (
    scenario.fault === 'malformed' &&
    scenario.dependency === 'sqlite.execute' &&
    violations.some(v => v.startsWith('S1 render threw'))
  ) {
    defects.push('D1-shotType-unvalidated-render-throw');
  }
  if (
    scenario.fault === 'malformed' &&
    scenario.dependency === 'sqlite.execute' &&
    violations.some(v => v.startsWith('S4 non-finite'))
  ) {
    defects.push('D2-score-overflow-nonfinite-average');
  }
  if (
    scenario.fault === 'malformed' &&
    scenario.dependency === 'sqlite.execute' &&
    violations.some(v => v.startsWith('S4 focus card rendered'))
  ) {
    defects.push('D3-fact-fields-unvalidated');
  }
  const attributed = defects.length > 0 ? defects.join('+') : null;
  return attributed;
}

// ---------------------------------------------------------------------------

const rows: ScenarioRow[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(Date.UTC(2026, 8, 5, 3, 0, 0));
  mockGetDb.mockReset();
});

afterEach(() => {
  clearApiSession();
  (globalThis as { fetch: unknown }).fetch = originalFetch;
  jest.useRealTimers();
});

afterAll(() => {
  writeCampaignReport(
    'screen-consumer',
    'cloud/linux jest (react-test-renderer)',
    'cd apps/mobile && STRESS_SEED=<seed> npx jest --ci __tests__/stress/libraryFocusFaultInjection.screen',
    rows,
  );
});

describe('mod-library-focus · failure-injection · DrillLibraryScreen consumer', () => {
  it('every seeded dependency fault either HOLDS or lands in a pinned defect class', async () => {
    const seeds = seedList('STRESS_ITER');
    const unattributed: ScenarioRow[] = [];
    for (const seed of seeds) {
      const scenario = buildScenario(seed);
      const { row } = await runScenario(scenario);
      rows.push(row);
      if (row.outcome === 'BROKEN' && row.defect === null)
        unattributed.push(row);
      jest.clearAllTimers();
    }
    expect(unattributed).toEqual([]);
    if (seeds.length >= DEFAULT_ITERATIONS) {
      const deps = new Set(rows.map(r => r.dependency));
      expect([...deps].sort()).toEqual(
        [
          'clock',
          'fetch.catalog',
          'navigation',
          'session.keychain',
          'sqlite.execute',
          'sqlite.getDb',
        ].sort(),
      );
      const faults = new Set(rows.map(r => r.fault));
      for (const mode of [
        'throw',
        'reject',
        'timeout',
        'never',
        'slow',
        'malformed',
        'partial',
      ]) {
        expect(faults.has(mode as FaultMode)).toBe(true);
      }
    }
    // Everything that is not a hang or a malformed row must HOLD.
    const mustHold = rows.filter(
      r =>
        !(
          r.dependency === 'fetch.catalog' &&
          (r.fault === 'never' || r.fault === 'timeout')
        ) &&
        !(r.dependency === 'sqlite.execute' && r.fault === 'malformed') &&
        !(r.defect ?? '').includes('D5'),
    );
    expect(mustHold.filter(r => r.outcome === 'BROKEN')).toEqual([]);
  });

  it('DEFECT: a catalog fetch that never settles leaves "Loading the drill catalog…" mounted after 60s with no retry or back control', async () => {
    const scenario: Scenario = {
      ...buildScenario(0),
      dependency: 'fetch.catalog',
      fault: 'never',
      fetch: 'never',
      db: { kind: 'rows', rows: focusRows() },
      session: 'ok',
      clock: null,
      navigationThrows: false,
      expectFocusPossible: true,
      detail: 'pinned',
    };
    const { row } = await runScenario(scenario);
    expect(row.outcome).toBe('BROKEN');
    expect(row.defect).toBe('D4-catalog-fetch-no-timeout-infinite-loading');
    expect(row.violations).toEqual(
      expect.arrayContaining([
        'S2 LoadingState still mounted after 60s',
        'S3 no retry/back control while catalog hangs',
      ]),
    );
  });

  it('DEFECT: a SQLite read failure renders the "after two scored analyses" hint — indistinguishable from having no evidence', async () => {
    const scenario: Scenario = {
      ...buildScenario(0),
      dependency: 'sqlite.execute',
      fault: 'reject',
      db: { kind: 'reject' },
      fetch: 'healthy',
      session: 'ok',
      clock: null,
      navigationThrows: false,
      expectFocusPossible: false,
      detail: 'pinned',
    };
    const { row } = await runScenario(scenario);
    expect(row.outcome).toBe('BROKEN');
    expect(row.defect).toBe(
      'D5-focus-read-failure-indistinguishable-from-thin-evidence',
    );
    // ...but the read IS recoverable through pull-to-refresh once SQLite heals.
    expect(row.detail).toContain('refresh recovered focus');
  });

  it('HELD: every catalog failure that settles shows Try again and recovers on press', async () => {
    const settling = FETCH_FAULTS.filter(
      f => f !== 'never' && f !== 'timeout' && f !== 'slow',
    );
    for (const fetchFault of settling) {
      const scenario: Scenario = {
        ...buildScenario(0),
        dependency: 'fetch.catalog',
        fault: fetchFaultMode(fetchFault) as FaultMode,
        fetch: fetchFault,
        db: { kind: 'rows', rows: focusRows() },
        session: 'ok',
        clock: null,
        navigationThrows: false,
        expectFocusPossible: true,
        detail: `matrix ${fetchFault}`,
      };
      const { row } = await runScenario(scenario);
      rows.push({ ...row, seed: -1 - settling.indexOf(fetchFault) });
      expect({ fetchFault, violations: row.violations }).toEqual({
        fetchFault,
        violations: [],
      });
      expect(row.detail).toContain('try-again recovered catalog');
    }
  });

  it('DEFECT: a stale slow focus read overwrites a fresher pull-to-refresh focus (no request guard in loadFocus)', async () => {
    // First read resolves at 30s with NO focus-capable rows; a pull-to-refresh
    // at 1s resolves immediately with focus rows. The fresher result wins at
    // 1s, then the stale read lands at 30s and clears it again.
    let call = 0;
    const slowEmpty = scriptedDb({ kind: 'delay', ms: 30_000, rows: [] });
    const fast = scriptedDb({ kind: 'rows', rows: focusRows() });
    mockGetDb.mockImplementation(() => (call++ === 0 ? slowEmpty : fast));
    const fetchScript = scriptedFetch('healthy', 0);
    (globalThis as { fetch: unknown }).fetch = (url: string) =>
      fetchScript.impl(url);
    establishApiSession({
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token-1',
      canonicalAppUserId: 'user-1',
      provider: 'apple',
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<DrillLibraryScreen />);
    });
    await settle(1000);
    const control = refreshControl(renderer);
    expect(control).not.toBeNull();
    await act(async () => {
      control!.props.onRefresh();
    });
    await settle(0);
    expect(hasTestId(renderer, 'library-focus')).toBe(true);
    await settle(HANG_BUDGET_MS);
    const stillFocused = hasTestId(renderer, 'library-focus');
    rows.push({
      seed: -100,
      dependency: 'sqlite.execute',
      fault: 'slow',
      detail: 'stale 30s read (no rows) vs pull-to-refresh at 1s (focus rows)',
      outcome: stillFocused ? 'HELD' : 'BROKEN',
      violations: stillFocused
        ? []
        : [
            'S4 stale read overwrote fresher focus',
            'S7 focus vanished silently',
          ],
      defect: stillFocused ? null : 'D6-stale-focus-read-overwrites-fresh',
      replay:
        'cd apps/mobile && npx jest --ci __tests__/stress/libraryFocusFaultInjection.screen -t "stale slow focus"',
    });
    expect(stillFocused).toBe(false);
    expect(slowEmpty.writes).toEqual([]);
    expect(fast.writes).toEqual([]);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('reference: the kit-level kept-row policy agrees with the real repository on healthy rows', async () => {
    const rowsIn = focusRows();
    const db = scriptedDb({ kind: 'rows', rows: rowsIn });
    const facts = await listScoredCheckpointFacts(db);
    expect(facts.map(f => f.id)).toEqual(
      rowsIn.map(r => referenceKept(r)?.id).filter(id => id !== undefined),
    );
    expect(db.writes).toEqual([]);
  });
});
