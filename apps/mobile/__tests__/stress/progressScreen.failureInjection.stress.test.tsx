/**
 * STRESS — ProgressScreen × failure injection.
 *
 * The real `ProgressScreen` is mounted inside a real `NavigationContainer`
 * (native stack → bottom tabs with the production `PremiumTabBar`, plus the
 * real `StreakCalendarScreen` it navigates to). Stores (`appStore`,
 * `consistencyStore`, `rankCelebrationStore`, `apiSession`) and hooks are the
 * production modules. Only two seams are faked, both native boundaries:
 *
 *   • `@op-engineering/op-sqlite` → a real SQLite file through `node:sqlite`
 *     with an injection layer in front of `execute()` / `open()`.
 *   • `globalThis.fetch` → a route-aware fake for `/v1/progress`, `/v1/rank`.
 *
 * Every catalog fault runs once (`FAULT_CATALOG`, ≥60 entries) and a seeded
 * random campaign perturbs fixture + drive order around them. Each iteration
 * advances fake timers 60s and asserts:
 *
 *   noInfiniteSpinner   the loading state is gone after 60s
 *   visibleControl      a failed local load shows the retry control
 *   recoverable         retry after the fault clears reaches the dashboard
 *   noFakeSuccess       a faulted account route never renders account data
 *   noSilentFailure     a failed consistency read is not shown as "0 days"
 *   noGarbage           no NaN / undefined / Invalid Date / [object Object]
 *   persistedIntact     kv stays valid JSON, durable drills survive, product
 *                       rows are byte-identical (the screen is read-only)
 *
 * Replay:  STRESS_SEED=<n> npx jest --ci __tests__/stress/progressScreen
 * Scale:   STRESS_ITER=<n> (random campaign size; default 12)
 * Output:  <repo>/artifacts/stress-progressscreen/<run>.json (STRESS_OUT
 *          overrides) — one row per executed iteration.
 */
import React from 'react';
import { Text, View } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { ProgressScreen } from '../../src/screens/ProgressScreen';
import { StreakCalendarScreen } from '../../src/screens/StreakCalendarScreen';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';
import type {
  MainTabParams,
  RootStackParams,
} from '../../src/navigation/params';
import { getDb } from '../../src/data/db';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { PROGRESS_REQUEST_TIMEOUT_MS } from '../../src/progress/api';
import { useAppStore } from '../../src/state/appStore';
import {
  consistencyKeyForOwner,
  useConsistencyStore,
} from '../../src/consistency/store';
import {
  rankCelebrationKeyForOwner,
  useRankCelebrationStore,
} from '../../src/progress/rankCelebration';
import {
  fs,
  loadNodeSqlite,
  nodeProcess,
  os,
  path,
  type SqlInputValue,
  type SqliteDatabaseSync,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  CANONICAL_MARKER,
  FAULT_CATALOG,
  NOT_REACHABLE_DEPENDENCIES,
  healthyProgressPayload,
  healthyRankPayload,
  intBetween,
  makeRng,
  pickOne,
  planFromSeed,
  type FaultPlan,
  type FetchBehavior,
  type FetchRoute,
  type Fixture,
  type OpenBehavior,
  type SqlRule,
  type SqlTarget,
} from '../../xc-harness/stress/progressScreenFaultCatalog';

declare const __dirname: string;

// ─── native seam 1: op-sqlite over node:sqlite with an injection layer ──────

interface Released {
  reject(error: Error): void;
}

interface SqlCall {
  target: SqlTarget;
  applied: string;
}

const mockSqlite = {
  sqlite: loadNodeSqlite(),
  file: '',
  open: { kind: 'ok' } as OpenBehavior,
  rules: [] as SqlRule[],
  pending: [] as Released[],
  calls: [] as SqlCall[],
  opens: 0,
  rowTransforms: {} as Partial<
    Record<
      SqlTarget,
      (rows: Record<string, unknown>[]) => Record<string, unknown>[]
    >
  >,
  reset() {
    this.open = { kind: 'ok' };
    this.rules = [];
    this.rowTransforms = {};
  },
  release() {
    const pending = this.pending;
    this.pending = [];
    for (const entry of pending) {
      entry.reject(new Error('released at teardown'));
    }
  },
  classify(sql: string, params: unknown[]): SqlTarget {
    if (sql.includes('SELECT payload FROM local_shot')) return 'facts';
    if (sql.includes('FROM local_capture')) return 'captures';
    if (
      sql.includes('FROM local_shot') &&
      sql.includes('ORDER BY captured_at ASC')
    ) {
      return 'activity';
    }
    if (sql.includes('SELECT value FROM kv')) {
      return typeof params[0] === 'string' &&
        params[0].startsWith('consistency:')
        ? 'ledgerRead'
        : 'kvRead';
    }
    if (sql.includes('INTO kv')) return 'kvWrite';
    return 'any';
  },
  matches(rule: SqlRule, target: SqlTarget): boolean {
    if (rule.target === 'any') return true;
    if (rule.target === 'kvRead')
      return target === 'kvRead' || target === 'ledgerRead';
    return rule.target === target;
  },
  openDatabase(name: string) {
    if (!this.sqlite) throw new Error('node:sqlite unavailable on this Node');
    this.opens += 1;
    const openBehavior = this.open;
    if (openBehavior.kind === 'throw') {
      if (openBehavior.remaining === undefined || openBehavior.remaining > 0) {
        if (openBehavior.remaining !== undefined) openBehavior.remaining -= 1;
        throw new Error(`op-sqlite: unable to open ${name}`);
      }
    }
    const inner = this.sqlite.DatabaseSync;
    const db = new inner(this.file);
    let syncIndex = 0;
    const runSync = (sql: string, params: unknown[]) => {
      const index = syncIndex;
      syncIndex += 1;
      if (
        openBehavior.kind === 'migrationThrowAt' &&
        index === openBehavior.statementIndex &&
        (openBehavior.remaining === undefined || openBehavior.remaining > 0)
      ) {
        if (openBehavior.remaining !== undefined) openBehavior.remaining -= 1;
        throw new Error('SQLITE_CORRUPT: database disk image is malformed');
      }
      const rows = db
        .prepare(sql)
        .all(...(params as SqlInputValue[])) as Record<string, unknown>[];
      return { rows };
    };
    const runReal = (sql: string, params: unknown[]) => {
      const rows = db
        .prepare(sql)
        .all(...(params as SqlInputValue[])) as Record<string, unknown>[];
      return { rows };
    };
    const execute = (sql: string, params: unknown[] = []) => {
      const target = this.classify(sql, params);
      let applied: SqlRule | null = null;
      for (const rule of this.rules) {
        if (!this.matches(rule, target)) continue;
        if (rule.skip !== undefined && rule.skip > 0) {
          rule.skip -= 1;
          continue;
        }
        if (rule.remaining !== undefined) {
          if (rule.remaining <= 0) continue;
          rule.remaining -= 1;
        }
        applied = rule;
        break;
      }
      this.calls.push({
        target,
        applied: applied ? applied.behavior.kind : 'real',
      });
      const real = () => {
        const result = runReal(sql, params);
        const transform = this.rowTransforms[target];
        return transform ? { rows: transform(result.rows) } : result;
      };
      if (!applied) return Promise.resolve(real());
      const behavior = applied.behavior;
      switch (behavior.kind) {
        case 'reject':
          return Promise.reject(new Error(behavior.message));
        case 'throwSync':
          throw new Error(behavior.message);
        case 'never':
          return new Promise<never>((_, reject) => {
            this.pending.push({ reject });
          });
        case 'slow':
          return new Promise(resolve =>
            setTimeout(resolve, behavior.delayMs),
          ).then(real);
        case 'nullResult':
          return Promise.resolve(null);
        case 'undefinedRows':
          return Promise.resolve({ rows: undefined });
        case 'objectRows':
          return Promise.resolve({ rows: { 0: { payload: '{}' } } });
      }
    };
    return {
      executeSync: (sql: string, params: unknown[] = []) =>
        runSync(sql, params),
      execute,
      close: () => db.close(),
    };
  },
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: (options: { name: string }) => mockSqlite.openDatabase(options.name),
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = require('react');
  const { View: RNView } = require('react-native');
  const passthrough = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(RNView, null, props.children);
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    SafeAreaProvider: passthrough,
    SafeAreaView: passthrough,
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    SafeAreaInsetsContext: ReactActual.createContext(insets),
    SafeAreaFrameContext: ReactActual.createContext(frame),
    initialWindowMetrics: { frame, insets },
  };
});

// ─── native seam 2: fetch ───────────────────────────────────────────────────

const fetchControl = {
  routes: {} as Partial<Record<FetchRoute, FetchBehavior>>,
  pending: [] as Released[],
  calls: [] as { route: FetchRoute | 'other'; applied: string }[],
  today: '2026-09-04',
  reset() {
    this.routes = {};
  },
  release() {
    const pending = this.pending;
    this.pending = [];
    for (const entry of pending)
      entry.reject(new Error('released at teardown'));
  },
};

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function neverWithAbort(
  signal: AbortSignal | null | undefined,
): Promise<never> {
  return new Promise<never>((_, reject) => {
    fetchControl.pending.push({ reject });
    if (signal) {
      if (signal.aborted) reject(abortError());
      else signal.addEventListener('abort', () => reject(abortError()));
    }
  });
}

function jsonResponse(status: number, body: () => Promise<unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: body,
  } as unknown as Response;
}

function fakeFetch(input: string, init?: RequestInit): Promise<Response> {
  const route: FetchRoute | 'other' = input.includes('/v1/progress')
    ? 'progress'
    : input.includes('/v1/rank')
      ? 'rank'
      : 'other';
  const behavior: FetchBehavior =
    route === 'other'
      ? { kind: 'reject' }
      : (fetchControl.routes[route] ?? { kind: 'ok' });
  fetchControl.calls.push({ route, applied: behavior.kind });
  const healthy = () =>
    route === 'progress'
      ? healthyProgressPayload(fetchControl.today)
      : healthyRankPayload();
  const okResponse = () => jsonResponse(200, async () => healthy());
  switch (behavior.kind) {
    case 'ok':
      return Promise.resolve(okResponse());
    case 'reject':
      return Promise.reject(new TypeError('Network request failed'));
    case 'throwSync':
      throw new TypeError('fetch is not available');
    case 'never':
      return neverWithAbort(init?.signal);
    case 'slow':
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(okResponse()), behavior.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(abortError());
        });
      });
    case 'status':
      return Promise.resolve(
        jsonResponse(behavior.status, async () => ({ error: 'x' })),
      );
    case 'bodyNonJson':
      return Promise.resolve(
        jsonResponse(200, async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        }),
      );
    case 'jsonNever':
      return Promise.resolve(
        jsonResponse(200, () => neverWithAbort(init?.signal)),
      );
    case 'payload':
      return Promise.resolve(jsonResponse(200, async () => behavior.payload));
  }
}

// ─── navigator (production shape: stack → tabs → Performance) ───────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<MainTabParams>();

function stub(label: string) {
  return function StubScreen() {
    return (
      <View>
        <Text>{label}</Text>
      </View>
    );
  };
}
const HomeStub = stub('stub:home');
const LibraryStub = stub('stub:library');
const AddStub = stub('stub:add');
const SettingsStub = stub('stub:settings');
const ResultStub = stub('stub:result');

function MainTabs() {
  return (
    <Tabs.Navigator
      initialRouteName="Performance"
      tabBar={props => <PremiumTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="Home" component={HomeStub} />
      <Tabs.Screen name="Library" component={LibraryStub} />
      <Tabs.Screen name="Add" component={AddStub} />
      <Tabs.Screen name="Performance" component={ProgressScreen} />
      <Tabs.Screen name="Settings" component={SettingsStub} />
    </Tabs.Navigator>
  );
}

function Harness() {
  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Tabs" component={MainTabs} />
        <Stack.Screen name="StreakCalendar" component={StreakCalendarScreen} />
        <Stack.Screen name="Result" component={ResultStub} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// ─── fixture ────────────────────────────────────────────────────────────────

const OWNER = '11111111-2222-4333-8444-555555555555';
const SHOTS = [
  'serve',
  'dink',
  'forehand_drive',
  'third_shot_drop',
  'volley',
] as const;

function isoDaysAgo(now: number, days: number, hour: number) {
  const date = new Date(now - days * 86_400_000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

function shotPayload(
  rng: () => number,
  id: string,
  shotType: string,
  capturedAtIso: string,
  score: number | null,
  sessionId: string | null,
): Record<string, unknown> {
  return {
    id,
    sessionId,
    shotType,
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso,
    timestamps: { startMs: 0, contactMs: 900, endMs: 1800 },
    phases: [],
    measurements: [],
    checkpoints: [
      {
        key: 'contact_position',
        score: score === null ? null : Math.round(score * 10),
        confidence: 0.8,
        band: 'good',
        direction: 'none',
        severity: 0,
        applicable: true,
      },
    ],
    overallScore: score,
    analysisConfidence: score === null ? 0.3 : 0.7 + rng() * 0.29,
    resultKind: score === null ? 'low_confidence' : 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      scoringModelVersion: 'srv-1',
      shotConfigVersion: 'cfg-1',
      poseModelVersion: 'pose-1',
      appVersion: '1.0.0',
    },
    source: 'real',
  };
}

function importedClip(
  uri: string,
  capturedAtIso: string,
  durationMs: number,
  fps: number,
  width: number,
  height: number,
): Record<string, unknown> {
  return {
    captureMode: 'imported_video',
    uri,
    durationMs,
    width,
    height,
    fps,
    capturedAtIso,
    recognition: { status: 'unknown', reason: 'not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  };
}

interface SeededState {
  factIds: string[];
  drillIds: string[];
  shotDigest: string;
  captureDigest: string;
}

function digest(db: SqliteDatabaseSync, sql: string): string {
  return JSON.stringify(db.prepare(sql).all(OWNER));
}

function seedFixture(
  db: SqliteDatabaseSync,
  owner: string,
  fixture: Fixture,
  rng: () => number,
  now: number,
): SeededState {
  const factIds: string[] = [];
  const insertShot = db.prepare(
    `INSERT OR REPLACE INTO local_shot
       (owner_key,id,session_id,shot_type,captured_at,overall_score,confidence,result_kind,source,favorite,payload)
     VALUES (?,?,?,?,?,?,?,?,?,0,?)`,
  );
  for (let index = 0; index < fixture.factCount; index += 1) {
    const id = `fact-${index}`;
    const shotType = pickOne(rng, SHOTS);
    const daysAgo =
      index === 0 ? 0 : intBetween(rng, 0, Math.max(0, fixture.spreadDays));
    let capturedAt = isoDaysAgo(now, daysAgo, intBetween(rng, 6, 20));
    if (fixture.facts === 'futureDates') {
      capturedAt = isoDaysAgo(now, -intBetween(rng, 1, 400), 12);
    } else if (fixture.facts === 'invalidDates') {
      capturedAt = pickOne(rng, [
        'not-a-date',
        '',
        '2026-13-45T99:00:00Z',
        'NaN',
      ]);
    }
    const lowConfidence = rng() < 0.15;
    const score = lowConfidence
      ? null
      : Math.round((3 + rng() * 6.5) * 10) / 10;
    const sessionId = rng() < 0.4 ? `session-${index % 3}` : null;
    let payload: string;
    const valid = shotPayload(rng, id, shotType, capturedAt, score, sessionId);
    switch (fixture.facts) {
      case 'nonJson':
        payload = pickOne(rng, ['{not json', '', 'undefined', '\u0000\u0001']);
        break;
      case 'wrongShape':
        payload = JSON.stringify(
          pickOne(rng, [{ id }, [], 42, { id, source: 'real' }]),
        );
        break;
      case 'stringScores':
        payload = JSON.stringify({
          ...valid,
          overallScore: pickOne(rng, ['7.5', 'abc', 'NaN', 'Infinity', {}]),
          analysisConfidence: pickOne(rng, ['0.9', null, -1]),
          checkpoints: [{ key: 'contact_position', score: 'high' }],
        });
        break;
      case 'fixtureSource':
        payload = JSON.stringify({ ...valid, source: 'fixture' });
        break;
      default:
        payload = JSON.stringify(valid);
    }
    insertShot.run(
      owner,
      id,
      sessionId,
      shotType,
      capturedAt,
      score,
      0.8,
      score === null ? 'low_confidence' : 'scored',
      'real',
      payload,
    );
    factIds.push(id);
  }

  const insertCapture = db.prepare(
    `INSERT OR REPLACE INTO local_capture
       (owner_key,id,uri,shot_type,declared_stroke,captured_at,duration_ms,fps,width,height,status,payload)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (let index = 0; index < fixture.captureCount; index += 1) {
    const id = `capture-${index}`;
    const uri = `file:///captures/${id}.mov`;
    const capturedAt = isoDaysAgo(
      now,
      intBetween(rng, 0, Math.max(0, fixture.spreadDays)),
      intBetween(rng, 6, 20),
    );
    const durationMs = intBetween(rng, 1500, 9000);
    const fps = pickOne(rng, [30, 60, 59.94]);
    const clip = importedClip(uri, capturedAt, durationMs, fps, 1080, 1920);
    let payload: string | null = JSON.stringify(clip);
    let durationCol: SqlInputValue = durationMs;
    let fpsCol: SqlInputValue = fps;
    switch (fixture.captures) {
      case 'nonJson':
        payload = pickOne(rng, ['{', 'null', 'true', '"str"']);
        break;
      case 'metadataMismatch':
        payload = JSON.stringify({ ...clip, durationMs: durationMs + 1 });
        break;
      case 'stringNumbers':
        durationCol = 'abc';
        fpsCol = 'thirty';
        break;
      case 'legacyNull':
        payload = null;
        break;
      default:
        break;
    }
    insertCapture.run(
      owner,
      id,
      uri,
      pickOne(rng, SHOTS),
      null,
      capturedAt,
      durationCol,
      fpsCol,
      1080,
      1920,
      pickOne(rng, ['awaiting_model', 'analyzed']),
      payload,
    );
  }
  const drillIds: string[] = [];
  const drills: Record<string, unknown>[] = [];
  for (let index = 0; index < fixture.ledgerDrillCount; index += 1) {
    const id = `drill-${index}`;
    drillIds.push(id);
    drills.push({
      id,
      slug: `drill-slug-${index}`,
      title: `Drill ${index}`,
      completedAtIso: isoDaysAgo(now, intBetween(rng, 1, 30), 9),
    });
  }
  const ledgerRecord = {
    version: 1,
    drills,
    celebrated: {},
    daySecuredShownDay: null,
  };
  let ledgerRaw: string | null = JSON.stringify(ledgerRecord);
  switch (fixture.ledger) {
    case 'truncated':
      ledgerRaw = ledgerRaw.slice(
        0,
        Math.max(3, Math.floor(ledgerRaw.length / 2)),
      );
      break;
    case 'array':
      ledgerRaw = JSON.stringify(drills);
      break;
    case 'number':
      ledgerRaw = '42';
      break;
    case 'drillsGarbage':
      ledgerRaw = JSON.stringify({
        ...ledgerRecord,
        drills: [
          ...drills,
          null,
          7,
          'x',
          { id: 'ghost' },
          { completedAtIso: 'never' },
        ],
      });
      break;
    default:
      break;
  }
  const insertKv = db.prepare(
    `INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`,
  );
  if (ledgerRaw !== null)
    insertKv.run(consistencyKeyForOwner(owner), ledgerRaw);
  let rankRaw: string | null = JSON.stringify({
    version: 1,
    tier: 'bronze',
    rating: 3.1,
  });
  if (fixture.rankRecord === 'garbage') rankRaw = '<<<garbage>>>';
  if (fixture.rankRecord === 'wrongTypes') {
    rankRaw = JSON.stringify({ tier: 12, rating: 'high' });
  }
  insertKv.run(rankCelebrationKeyForOwner(owner), rankRaw);

  return {
    factIds,
    drillIds,
    shotDigest: digest(
      db,
      'SELECT * FROM local_shot WHERE owner_key = ? ORDER BY id',
    ),
    captureDigest: digest(
      db,
      'SELECT * FROM local_capture WHERE owner_key = ? ORDER BY id',
    ),
  };
}

// ─── render helpers ─────────────────────────────────────────────────────────

function textOf(tree: ReactTestRenderer): string {
  const parts: string[] = [];
  const walk = (node: ReactTestInstance) => {
    for (const child of node.children) {
      if (typeof child === 'string') parts.push(child);
      else walk(child);
    }
  };
  walk(tree.root);
  return parts.join('\u241f');
}

function findByLabel(
  tree: ReactTestRenderer,
  label: string,
): ReactTestInstance | null {
  const matches = tree.root.findAll(
    node =>
      typeof node.type !== 'string' &&
      node.props['accessibilityLabel'] === label &&
      typeof node.props['onPress'] === 'function',
  );
  return matches[0] ?? null;
}

function findPressableWithText(
  tree: ReactTestRenderer,
  text: string,
): ReactTestInstance | null {
  const candidates = tree.root.findAll(
    node =>
      typeof node.type !== 'string' &&
      typeof node.props['onPress'] === 'function' &&
      (node.props['accessibilityLabel'] === text ||
        textOfInstance(node) === text),
  );
  return candidates[0] ?? null;
}

function textOfInstance(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (current: ReactTestInstance) => {
    for (const child of current.children) {
      if (typeof child === 'string') parts.push(child);
      else walk(child);
    }
  };
  walk(node);
  return parts.join('');
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  const steps = Math.max(1, Math.ceil(ms / 1_000));
  const per = ms / steps;
  for (let index = 0; index < steps; index += 1) {
    await act(async () => {
      jest.advanceTimersByTime(per);
      for (let inner = 0; inner < 6; inner += 1) await Promise.resolve();
    });
  }
}

async function press(node: ReactTestInstance | null): Promise<boolean> {
  if (!node) return false;
  await act(async () => {
    (node.props['onPress'] as () => void)();
    await Promise.resolve();
  });
  return true;
}

const SPINNER = 'Loading measured progress…';
const ERROR_TITLE = 'Progress couldn’t load';
const RETRY = 'Try again';
const DASHBOARD_MARKER = 'CONSISTENCY';
const CANONICAL_TEXT = CANONICAL_MARKER.replace(/_/g, ' ');
const CONSISTENCY_FAKE_ZERO = 'Your first analysis lights the flame.';
const GARBAGE = [
  'NaN',
  'undefined',
  'null',
  'Infinity',
  'Invalid Date',
  '[object Object]',
];

// ─── iteration ──────────────────────────────────────────────────────────────

interface IterationRow {
  seed: number;
  faultId: string;
  category: string;
  description: string;
  expect: FaultPlan['expect'];
  fixture: Fixture;
  session: FaultPlan['session'];
  clock: FaultPlan['clock'];
  interactions: string[];
  interactionsApplied: string[];
  sqlCalls: number;
  faultsApplied: number;
  fetchCalls: number;
  invariants: Record<string, boolean>;
  outcome: 'HELD' | 'BROKEN';
  failures: string[];
  consoleErrors: string[];
  durationMs: number;
}

const results: IterationRow[] = [];

function installIntlFault(): () => void {
  const RealDateTimeFormat = Intl.DateTimeFormat;
  const patched = function DateTimeFormatPatched(
    this: unknown,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    if (locales === undefined && options === undefined) {
      throw new RangeError('Incorrect locale information provided');
    }
    return new RealDateTimeFormat(locales, options);
  } as unknown as typeof Intl.DateTimeFormat;
  Object.defineProperty(patched, 'supportedLocalesOf', {
    value: RealDateTimeFormat.supportedLocalesOf,
  });
  Object.defineProperty(Intl, 'DateTimeFormat', {
    value: patched,
    configurable: true,
    writable: true,
  });
  return () => {
    Object.defineProperty(Intl, 'DateTimeFormat', {
      value: RealDateTimeFormat,
      configurable: true,
      writable: true,
    });
  };
}

function cloneRules(rules: SqlRule[]): SqlRule[] {
  return rules.map(rule => ({ ...rule, behavior: { ...rule.behavior } }));
}

function faultedRoutes(plan: FaultPlan): Set<FetchRoute> {
  const set = new Set<FetchRoute>();
  for (const route of ['progress', 'rank'] as const) {
    const behavior = plan.fetch[route];
    if (!behavior || behavior.kind === 'ok') continue;
    // a slow response that lands inside the request timeout is a success
    if (
      behavior.kind === 'slow' &&
      (route === 'rank' || behavior.delayMs < PROGRESS_REQUEST_TIMEOUT_MS)
    ) {
      continue;
    }
    set.add(route);
  }
  return set;
}

async function runIteration(
  seed: number,
  plan: FaultPlan,
): Promise<IterationRow> {
  const started = Date.now();
  const rng = makeRng(seed ^ 0x9e3779b9);
  const consoleErrors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' ').slice(0, 300));
    });
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation(() => undefined);

  // clock
  const REAL_NOW = Date.UTC(2026, 8, 4, 18, 30, 0);
  let now = REAL_NOW;
  if (plan.clock === 'farFuture') now = Date.UTC(2099, 0, 1, 12, 0, 0);
  if (plan.clock === 'epoch') now = 0;
  jest.setSystemTime(now);
  fetchControl.today = new Date(now).toISOString().slice(0, 10);
  let restoreIntl: (() => void) | null = null;

  // owner + session
  const owner = plan.session === 'none' ? GUEST_DATA_OWNER : OWNER;
  setActiveDataOwner(owner);
  clearApiSession();
  if (plan.session === 'account' || plan.session === 'clearMidFlight') {
    establishApiSession({
      apiBaseUrl: 'https://api.stress.test',
      bearerToken: 'stress-bearer',
      canonicalAppUserId: OWNER,
      provider: 'apple',
    });
  } else if (plan.session === 'malformedAccount') {
    establishApiSession({
      apiBaseUrl: 'not a url',
      bearerToken: '',
      canonicalAppUserId: OWNER,
      provider: 'google',
    });
  }

  // stores
  useAppStore.setState({
    hydrated: true,
    ownerKey: owner,
    profile:
      plan.fixture.profileSkillLevel === null
        ? null
        : {
            skillLevel: plan.fixture.profileSkillLevel,
            handedness: 'right',
            goal: 'dinks',
            biggestProblem: 'consistency',
            focusCheckpoint: 'contact_position',
          },
  });
  useConsistencyStore.setState({
    hydrated: true,
    ownerKey: owner,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
  useRankCelebrationStore.setState({ current: null, pending: null });

  // database file + fixture (seeded through a healthy open, then closed so
  // the screen's own getDb() re-opens it under the fault)
  mockSqlite.reset();
  fetchControl.reset();
  // drain anything a previous iteration left hanging (the production code
  // may still hold continuations on released promises / stale timers)
  mockSqlite.release();
  fetchControl.release();
  jest.clearAllTimers();
  await flush();
  await flush();
  try {
    getDb().close();
  } catch {
    // nothing open
  }
  mockSqlite.calls = [];
  fetchControl.calls = [];
  mockSqlite.file = path.join(
    os.tmpdir(),
    `pickle-stress-${nodeProcess.env['JEST_WORKER_ID'] ?? '0'}-${seed}.db`,
  );
  fs.rmSync(mockSqlite.file, { force: true });
  const healthyDb = getDb();
  await healthyDb.execute('SELECT 1');
  const sqlite = mockSqlite.sqlite;
  if (!sqlite) throw new Error('node:sqlite unavailable on this Node');
  const seedDb = new sqlite.DatabaseSync(mockSqlite.file);
  const seeded = seedFixture(seedDb, owner, plan.fixture, rng, now);
  seedDb.close();
  healthyDb.close();

  // arm the faults
  mockSqlite.open = { ...plan.open };
  mockSqlite.rules = cloneRules(plan.sql);
  if (plan.fixture.facts === 'missingColumn') {
    mockSqlite.rowTransforms.facts = rows => rows.map(() => ({ id: 'x' }));
  }
  if (plan.fixture.captures === 'missingStatus') {
    mockSqlite.rowTransforms.captures = rows =>
      rows.map(row => {
        const rest = { ...row };
        delete rest['status'];
        return rest;
      });
  }
  fetchControl.routes = { ...plan.fetch };
  if (plan.clock === 'intlThrows') restoreIntl = installIntlFault();
  globalThis.fetch = fakeFetch as unknown as typeof fetch;

  const failures: string[] = [];
  const invariants: Record<string, boolean> = {};
  const check = (name: string, ok: boolean, detail: string) => {
    invariants[name] = invariants[name] === false ? false : ok;
    if (!ok) failures.push(`${name}: ${detail}`);
  };
  const interactionsApplied: string[] = [];

  let tree: ReactTestRenderer | null = null;
  let mounted = false;
  const mount = async () => {
    await act(async () => {
      tree = TestRenderer.create(<Harness />);
    });
    mounted = true;
    await flush();
  };
  const unmount = async () => {
    if (!tree || !mounted) return;
    const current = tree;
    mounted = false;
    await act(async () => {
      current.unmount();
    });
  };
  const view = (): ReactTestRenderer => {
    if (!tree) throw new Error('harness: tree not mounted');
    return tree;
  };

  try {
    await drive();
  } catch (error) {
    check(
      'noCrash',
      false,
      `${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
    );
  }

  async function drive(): Promise<void> {
    await mount();

    const interactions = [...plan.interactions];
    if (plan.session === 'clearMidFlight') {
      await advance(500);
      clearApiSession();
      interactionsApplied.push('clearApiSession@500ms');
    }
    if (interactions.includes('unmountMidFlight')) {
      await advance(500);
      await unmount();
      interactionsApplied.push('unmount@500ms');
      await advance(60_000);
      mockSqlite.release();
      fetchControl.release();
      await flush();
      check(
        'noStateUpdateAfterUnmount',
        !consoleErrors.some(line =>
          /unmounted|not wrapped in act|Can't perform/i.test(line),
        ),
        consoleErrors.join(' | '),
      );
      // remount fresh: the screen must load again from the same store state
      await mount();
    }

    await advance(60_000);
    let text = textOf(view());
    const textAfterLoad = text;
    const spinnerAfter60s = text.includes(SPINNER);
    const errorVisible = text.includes(ERROR_TITLE);
    const retryControl = findPressableWithText(view(), RETRY);
    const dashboardVisible = text.includes(DASHBOARD_MARKER) && !errorVisible;

    check(
      'noInfiniteSpinner',
      !spinnerAfter60s,
      'loading state still visible after 60s',
    );

    if (plan.expect === 'errorState') {
      check(
        'visibleControl',
        errorVisible && retryControl !== null,
        `error=${errorVisible} retry=${retryControl !== null}`,
      );
      check(
        'noFakeSuccess',
        !dashboardVisible,
        'dashboard rendered although the local load faulted',
      );
    } else if (plan.expect === 'dashboard') {
      check(
        'dashboardVisible',
        dashboardVisible,
        `dashboard=${dashboardVisible} error=${errorVisible} spinner=${spinnerAfter60s}`,
      );
    }

    // drive the mounted screen
    for (const interaction of interactions) {
      let applied = false;
      switch (interaction) {
        case 'switchPractice':
          applied = await press(findByLabel(view(), 'practice progress'));
          break;
        case 'switchTechnique':
          applied = await press(findByLabel(view(), 'technique progress'));
          break;
        case 'range7d':
          applied = await press(findByLabel(view(), '7 days range'));
          break;
        case 'range28d':
          applied = await press(findByLabel(view(), '4 weeks range'));
          break;
        case 'range90d':
          applied = await press(findByLabel(view(), '90 days range'));
          break;
        case 'openStreakCalendar': {
          const card = view().root.findAll(
            node => node.props['testID'] === 'consistency-card',
          )[0];
          applied = await press(card ?? null);
          break;
        }
        case 'goBack':
          applied = await press(findByLabel(view(), 'Back'));
          break;
        case 'tabAway':
          applied = await press(findByLabel(view(), 'Home'));
          break;
        case 'tabBack':
          applied = await press(findByLabel(view(), 'Progress'));
          break;
        case 'retryTwice': {
          const retry = findPressableWithText(view(), RETRY);
          if (retry) {
            await press(retry);
            await press(findPressableWithText(view(), RETRY));
            applied = true;
          }
          break;
        }
        case 'unmountMidFlight':
          applied = true;
          break;
      }
      if (applied) interactionsApplied.push(interaction);
      await advance(2_000);
      check(
        'noCrashDuringInteraction',
        !consoleErrors.some(line =>
          /The above error occurred|Uncaught/i.test(line),
        ),
        consoleErrors.join(' | '),
      );
    }
    await advance(5_000);
    text = textOf(view());

    // interactions may have left the Progress tab (Home, calendar); the
    // remaining assertions are about the Progress screen itself
    const backToProgress = async () => {
      const back = findByLabel(view(), 'Back');
      if (back) await press(back);
      const progressTab = findByLabel(view(), 'Progress');
      if (progressTab) await press(progressTab);
      await advance(2_000);
    };

    // garbage never reaches the player
    const garbage = GARBAGE.filter(token =>
      text.split('\u241f').some(part => part === token || part.includes(token)),
    );
    check('noGarbage', garbage.length === 0, `rendered ${garbage.join(',')}`);

    // account data: never faked, present when healthy
    const routesFaulted = faultedRoutes(plan);
    // a request issued while signed in may legitimately land after the
    // session is cleared; the screen is not asked to un-render it
    const accountLive =
      plan.session === 'account' || plan.session === 'clearMidFlight';
    const canonicalShown =
      text.includes(CANONICAL_TEXT) || textAfterLoad.includes(CANONICAL_TEXT);
    if (!accountLive || routesFaulted.has('progress')) {
      check(
        'noFakeSuccess',
        !canonicalShown,
        'account progress rendered from a faulted route',
      );
    } else if (
      dashboardVisible &&
      !textAfterLoad.includes(ERROR_TITLE) &&
      plan.clock !== 'intlThrows'
    ) {
      // the technique view (the default) carries the account section
      check(
        'accountDataReachesScreen',
        textAfterLoad.includes(CANONICAL_TEXT),
        'healthy /v1/progress payload never rendered',
      );
    }

    // consistency honesty
    const consistency = useConsistencyStore.getState();
    if (consistency.loadError && textAfterLoad.includes(DASHBOARD_MARKER)) {
      check(
        'noSilentFailure',
        !textAfterLoad.includes(CONSISTENCY_FAKE_ZERO),
        'consistency read failed but the card claims a fresh 0-day start',
      );
    }

    // recoverability: an error state must come back once the fault is gone
    if (
      plan.expect === 'errorState' ||
      (errorVisible && plan.expect !== 'hung')
    ) {
      await backToProgress();
      if (!plan.recoversOnRetry) {
        // retry while the fault is still live must not claim success
        await press(findPressableWithText(view(), RETRY));
        await advance(60_000);
        const still = textOf(view());
        check(
          'noFakeSuccess',
          !(still.includes(DASHBOARD_MARKER) && !still.includes(ERROR_TITLE)),
          'retry under a live fault rendered the dashboard',
        );
        check(
          'noInfiniteSpinner',
          !still.includes(SPINNER),
          'retry under a live fault spun for 60s',
        );
        mockSqlite.reset();
        fetchControl.reset();
      }
      const current = textOf(view());
      const retry = findPressableWithText(view(), RETRY);
      if (
        current.includes(DASHBOARD_MARKER) &&
        !current.includes(ERROR_TITLE)
      ) {
        check('recoverable', true, '');
      } else if (retry) {
        await press(retry);
        await advance(60_000);
        const after = textOf(view());
        check(
          'recoverable',
          after.includes(DASHBOARD_MARKER) &&
            !after.includes(ERROR_TITLE) &&
            !after.includes(SPINNER),
          `after retry: error=${after.includes(ERROR_TITLE)} spinner=${after.includes(SPINNER)}`,
        );
      } else {
        check('recoverable', false, 'no retry control to recover with');
      }
    }
    if (plan.expect === 'hung') {
      // lens-declared expectation: even a hung local read must not spin forever
      check(
        'visibleControl',
        text.includes(ERROR_TITLE) ||
          findPressableWithText(view(), RETRY) !== null,
        'no retry/back control while the local read hangs',
      );
    }
  }

  // teardown: release hung promises with the tree still mounted (late
  // settlement must not crash), then unmount
  mockSqlite.release();
  fetchControl.release();
  await flush();
  try {
    await unmount();
  } catch (error) {
    check(
      'noCrash',
      false,
      `unmount: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await flush();
  if (restoreIntl) restoreIntl();
  jest.clearAllTimers();

  // persisted state
  const verifyDb = new sqlite.DatabaseSync(mockSqlite.file);
  try {
    const kvRows = verifyDb.prepare('SELECT key, value FROM kv').all() as {
      key: string;
      value: string;
    }[];
    for (const row of kvRows) {
      const seededGarbage =
        (row.key.startsWith('consistency:') &&
          plan.fixture.ledger !== 'valid') ||
        (row.key.startsWith('rank.celebrated:') &&
          plan.fixture.rankRecord !== 'valid');
      if (seededGarbage) continue;
      let parses = true;
      try {
        JSON.parse(row.value);
      } catch {
        parses = false;
      }
      check(
        'persistedIntact',
        parses,
        `kv ${row.key} is not JSON after the run`,
      );
    }
    if (plan.fixture.ledger === 'valid' && plan.fixture.ledgerDrillCount > 0) {
      const ledgerRow = kvRows.find(
        row => row.key === consistencyKeyForOwner(owner),
      );
      let drillIds: string[] = [];
      if (ledgerRow) {
        const parsed = JSON.parse(ledgerRow.value) as {
          drills?: { id: string }[];
        };
        drillIds = (parsed.drills ?? []).map(drill => drill.id);
      }
      const missing = seeded.drillIds.filter(id => !drillIds.includes(id));
      check(
        'persistedIntact',
        missing.length === 0,
        `durable drill records lost: ${missing.join(',')}`,
      );
    }
    check(
      'persistedIntact',
      digest(
        verifyDb,
        'SELECT * FROM local_shot WHERE owner_key = ? ORDER BY id',
      ) === seeded.shotDigest,
      'local_shot rows changed under a read-only screen',
    );
    check(
      'persistedIntact',
      digest(
        verifyDb,
        'SELECT * FROM local_capture WHERE owner_key = ? ORDER BY id',
      ) === seeded.captureDigest,
      'local_capture rows changed under a read-only screen',
    );
  } finally {
    verifyDb.close();
  }
  try {
    getDb().close();
  } catch {
    // the open fault may still be armed; nothing to close then
  }
  fs.rmSync(mockSqlite.file, { force: true });

  const reactErrors = consoleErrors.filter(line =>
    /The above error occurred|Cannot update a component|unmounted component|Each child in a list/i.test(
      line,
    ),
  );
  check('noReactErrors', reactErrors.length === 0, reactErrors.join(' | '));

  errorSpy.mockRestore();
  warnSpy.mockRestore();

  const row: IterationRow = {
    seed,
    faultId: plan.id,
    category: plan.category,
    description: plan.description,
    expect: plan.expect,
    fixture: plan.fixture,
    session: plan.session,
    clock: plan.clock,
    interactions: plan.interactions,
    interactionsApplied,
    sqlCalls: mockSqlite.calls.length,
    faultsApplied:
      mockSqlite.calls.filter(call => call.applied !== 'real').length +
      fetchControl.calls.filter(call => call.applied !== 'ok').length,
    fetchCalls: fetchControl.calls.length,
    invariants,
    outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
    failures,
    consoleErrors: consoleErrors.slice(0, 5),
    durationMs: Date.now() - started,
  };
  results.push(row);
  return row;
}

// ─── suite ──────────────────────────────────────────────────────────────────

const STRESS_ITER = Number(nodeProcess.env['STRESS_ITER'] ?? '12');
const STRESS_SEED = nodeProcess.env['STRESS_SEED'];
const STRESS_OUT = nodeProcess.env['STRESS_OUT'];

function catalogSeed(index: number): number {
  return 1_000_000 + index;
}

beforeAll(() => {
  jest.useFakeTimers();
});

afterAll(() => {
  jest.useRealTimers();
  const dir =
    STRESS_OUT && STRESS_OUT.length > 0
      ? STRESS_OUT
      : path.resolve(__dirname, '../../../../artifacts/stress-progressscreen');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const summary = {
    unit: 'scr-progressscreen',
    lens: 'failure-injection',
    catalogSize: FAULT_CATALOG.length,
    randomIterations: STRESS_ITER,
    executed: results.length,
    held: results.filter(row => row.outcome === 'HELD').length,
    broken: results
      .filter(row => row.outcome === 'BROKEN')
      .map(row => ({
        seed: row.seed,
        faultId: row.faultId,
        failures: row.failures,
      })),
    notReachable: NOT_REACHABLE_DEPENDENCIES,
    rows: results,
  };
  fs.writeFileSync(
    path.join(dir, `progressscreen-failure-injection-${stamp}.json`),
    JSON.stringify(summary, null, 2) + '\n',
  );
});

describe('ProgressScreen × failure injection (catalog, one seed per fault)', () => {
  const catalog = STRESS_SEED
    ? FAULT_CATALOG.filter(
        (_, index) => catalogSeed(index) === Number(STRESS_SEED),
      )
    : FAULT_CATALOG;
  it('has the required fault count', () => {
    expect(FAULT_CATALOG.length).toBeGreaterThanOrEqual(60);
    expect(new Set(FAULT_CATALOG.map(plan => plan.id)).size).toBe(
      FAULT_CATALOG.length,
    );
  });
  if (catalog.length === 0) {
    it('catalog not selected by STRESS_SEED (random-campaign replay)', () => {
      expect(catalog).toEqual([]);
    });
  }
  if (catalog.length > 0) {
    test.each(
      catalog.map(
        plan =>
          [plan.id, catalogSeed(FAULT_CATALOG.indexOf(plan)), plan] as const,
      ),
    )(
      '%s (seed %i)',
      async (_id, seed, plan) => {
        const row = await runIteration(seed, plan);
        expect(row.failures).toEqual([]);
      },
      60_000,
    );
  }
});

describe('ProgressScreen × failure injection (seeded random campaign)', () => {
  const seeds: number[] = STRESS_SEED
    ? Number(STRESS_SEED) >= 1_000_000
      ? []
      : [Number(STRESS_SEED)]
    : Array.from({ length: STRESS_ITER }, (_, index) => 7_001 + index * 13);
  if (seeds.length === 0) {
    it('random campaign not requested (STRESS_ITER=0 or catalog seed replay)', () => {
      expect(seeds).toEqual([]);
    });
  }
  if (seeds.length > 0) {
    test.each(
      seeds.map(
        seed => [seed, planFromSeed(seed).id, planFromSeed(seed)] as const,
      ),
    )(
      'seed %i → %s',
      async (seed, _id, plan) => {
        const row = await runIteration(seed, plan);
        expect(row.failures).toEqual([]);
      },
      60_000,
    );
  }
});

describe('replayability', () => {
  it('the same seed yields the same plan', () => {
    expect(planFromSeed(4242)).toEqual(planFromSeed(4242));
    expect(planFromSeed(4242).id).not.toEqual(planFromSeed(4243).id + 'x');
  });
});
