/**
 * STRESS — StreakCalendarScreen, lens boundary/i18n/a11y.
 *
 * The screen is rendered INSIDE the real NavigationContainer + native stack
 * (a sentinel Home route underneath so Back is a real pop), the REAL
 * consistency store, the REAL SQLite repository (production `src/data/db.ts`
 * migrations run against node:sqlite through the op-sqlite seam) and the
 * real engine. Only native modules are replaced: op-sqlite → node:sqlite,
 * safe-area-context → its shipped jest mock, react-native-screens/reanimated
 * → the repo's existing mocks.
 *
 * Every iteration is a pure function of its seed: device locale, zone,
 * clock instant (DST / midnight edges), window width, fontScale, activity
 * history (empty → thousands of rows, hostile shot_type / drill titles,
 * hostile scores and captured_at values), store mode (db / unreadable db /
 * pending load / signed-out) and the interaction script. Results go to a
 * JSON table (seed → outcome) under artifacts/stress-streak-calendar/.
 *
 *   STRESS_ITER=<n>     iterations (default 24; campaign runs used 200+)
 *   STRESS_SEED=<seed>  replay exactly one seed
 *   STRESS_BASE=<n>     campaign base seed (default 20260905)
 *   STRESS_ARTIFACT_DIR overrides the artifact directory
 *   TZ                  the DEVICE zone. Jest sandboxes `process.env`, so
 *                       the zone cannot change inside a run —
 *                       scripts/stress-streak-calendar-matrix.sh runs this
 *                       file once per zone. Locale IS varied per seed
 *                       in-process (Date/Number toLocale* default-locale
 *                       shim); zone is not.
 *
 * Invariants marked VERIFIED are read straight off the rendered tree and
 * FAIL the suite. Invariants marked INFERRED are style arithmetic (no Yoga
 * in react-test-renderer) — they are recorded per row and summarised, never
 * asserted, and are reported as findings by the campaign that runs them.
 */
import React from 'react';
import { Dimensions, Text, View } from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StreakCalendarScreen } from '../../src/screens/StreakCalendarScreen';
import { useConsistencyStore } from '../../src/consistency/store';
import { getDb } from '../../src/data/db';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type { ConsistencySnapshot } from '../../src/consistency/engine';
import {
  fs,
  loadNodeSqlite,
  nodeProcess,
  path,
  type SqlInputValue,
} from '../../xc-harness/lifecycle-persistence/nodeShim';
import {
  CLOCK_EDGES,
  FONT_SCALES,
  HOSTILE_INSTANTS,
  HOSTILE_SCORES,
  HOSTILE_STRINGS,
  LOCALES,
  MIN_TARGET_PT,
  WIDTHS,
  type Locale,
} from '../../xc-harness/stress-streak-calendar/corpus';
import {
  campaignSeed,
  SeededRng,
} from '../../xc-harness/stress-streak-calendar/rng';
import {
  auditPressables,
  auditTexts,
  collectText,
  dayCellGeometry,
  firstHost,
  flatStyle,
  hostAncestor,
  hostType,
  isPressableNode,
  serializeHost,
  type PressableAudit,
} from '../../xc-harness/stress-streak-calendar/treeAudit';

declare const __dirname: string;

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

// ─── op-sqlite seam → node:sqlite, with fault injection ──────────────────────

const sqlite = loadNodeSqlite();
if (!sqlite) {
  throw new Error(
    'node:sqlite unavailable — run with Node >= 22.13 (apps/mobile engines).',
  );
}

const faults = {
  /** Every `execute` rejects (unreadable database). */
  executeThrows: false,
  /** Every `execute` never settles (load in flight). */
  executePending: false,
  pendingResolvers: [] as Array<() => void>,
};

const mockSqlite = {
  inner: null as InstanceType<typeof sqlite.DatabaseSync> | null,
  open() {
    mockSqlite.inner = new sqlite.DatabaseSync(':memory:');
    const inner = mockSqlite.inner;
    const run = (sql: string, params: unknown[]) => {
      const statement = inner.prepare(sql);
      const rows = /^\s*(select|pragma)/i.test(sql)
        ? (statement.all(...(params as SqlInputValue[])) as Record<
            string,
            unknown
          >[])
        : (statement.run(...(params as SqlInputValue[])), []);
      return { rows };
    };
    return {
      executeSync: (sql: string, params: unknown[] = []) => run(sql, params),
      execute: async (sql: string, params: unknown[] = []) => {
        if (faults.executeThrows) throw new Error('SQLITE_IOERR (injected)');
        if (faults.executePending) {
          await new Promise<void>(resolve => {
            faults.pendingResolvers.push(resolve);
          });
        }
        return run(sql, params);
      },
      close: () => {
        inner.close();
        mockSqlite.inner = null;
      },
    };
  },
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => mockSqlite.open(),
}));

// ─── Device simulation ───────────────────────────────────────────────────────

const device = { locale: 'en-US' as string };
const realToLocaleDateString = Date.prototype.toLocaleDateString;
const realToLocaleTimeString = Date.prototype.toLocaleTimeString;
const realToLocaleString = Date.prototype.toLocaleString;
const realNumberToLocaleString = Number.prototype.toLocaleString;
const realDimensionsGet = Dimensions.get.bind(Dimensions);

function installDeviceLocale() {
  const withLocale = <T extends (...args: never[]) => string>(original: T): T =>
    function patched(
      this: Date | number,
      locales?: string | string[],
      options?: Intl.DateTimeFormatOptions | Intl.NumberFormatOptions,
    ) {
      return original.call(
        this,
        (locales ?? device.locale) as never,
        options as never,
      );
    } as unknown as T;
  Date.prototype.toLocaleDateString = withLocale(realToLocaleDateString);
  Date.prototype.toLocaleTimeString = withLocale(realToLocaleTimeString);
  Date.prototype.toLocaleString = withLocale(realToLocaleString);
  Number.prototype.toLocaleString = withLocale(realNumberToLocaleString);
}

function restoreDeviceLocale() {
  Date.prototype.toLocaleDateString = realToLocaleDateString;
  Date.prototype.toLocaleTimeString = realToLocaleTimeString;
  Date.prototype.toLocaleString = realToLocaleString;
  Number.prototype.toLocaleString = realNumberToLocaleString;
}

function setWindow(width: number, fontScale: number) {
  const dims = { width, height: Math.round(width * 2.16), scale: 3, fontScale };
  Dimensions.set({ window: dims, screen: dims });
}

/** The zone this jest process was launched in — the device zone for every
 * seed of this run (see the header: TZ cannot change inside a sandbox). */
const DEVICE_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// ─── Variant generation (pure function of the seed) ──────────────────────────

type StoreMode = 'db' | 'unreadable-db' | 'pending-load' | 'signed-out';
type HistoryProfile =
  | 'empty'
  | 'single-today'
  | 'streak'
  | 'streak-at-risk'
  | 'dense-year'
  | 'ancient'
  | 'huge-day'
  | 'hostile-only';

interface ShotRow {
  id: string;
  sessionId: string | null;
  shotType: string;
  capturedAt: string;
  overallScore: number | string | null;
  resultKind: string;
}

interface DrillRecordRow {
  id: string;
  slug: string;
  title: string;
  completedAtIso: string;
}

interface Variant {
  seed: number;
  locale: Locale;
  /** Device zone (process TZ) — recorded, not chosen by the seed. */
  timeZone: string;
  clockEdgeId: string | null;
  nowIso: string;
  width: number;
  fontScale: number;
  storeMode: StoreMode;
  history: HistoryProfile;
  shotRows: number;
  drillRows: number;
  hostileStringIds: string[];
  hostileScoreIds: string[];
  hostileInstantIds: string[];
  /** Interaction script: prev/next presses, day taps, back, retry. */
  script: string[];
}

interface Fixture {
  variant: Variant;
  shots: ShotRow[];
  drills: DrillRecordRow[];
  /** Hostile payload strings expected to surface as activity labels. */
  payloads: string[];
}

function localDayStartIso(now: Date, zone: string, daysBack: number): string {
  // An instant on the local day `daysBack` days before `now`'s local day, at
  // the same wall-clock time minus 30s so the daysBack=0 row is never in the
  // future (the engine drops future rows) and never before local midnight.
  // Zone offset is taken at `now`; the engine re-buckets by its own rules.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map(p => [p.type, p.value]),
  ) as Record<string, string>;
  const localAsUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']) % 24,
    Number(parts['minute']),
    Number(parts['second']),
  );
  const offsetMs = localAsUtc - now.getTime();
  const targetLocalMidnight = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']) - daysBack,
  );
  const sinceMidnight =
    localAsUtc -
    Date.UTC(
      Number(parts['year']),
      Number(parts['month']) - 1,
      Number(parts['day']),
    );
  const wallClock = Math.max(0, sinceMidnight - 30_000);
  return new Date(targetLocalMidnight + wallClock - offsetMs).toISOString();
}

function generateFixture(seed: number): Fixture {
  const rng = new SeededRng(seed);
  const timeZone = DEVICE_ZONE;
  // ICU may canonicalise a zone (Asia/Kathmandu → Asia/Katmandu); compare
  // the resolved names so DST/midnight edges still apply.
  const edgesForZone = CLOCK_EDGES.filter(
    e =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: e.timeZone,
      }).resolvedOptions().timeZone === timeZone,
  );
  const useEdge = edgesForZone.length > 0 && rng.chance(0.6);
  const edge = useEdge ? rng.pick(edgesForZone) : null;
  const nowIso =
    edge?.nowIso ??
    new Date(
      Date.UTC(2026, rng.int(12), rng.range(1, 28), rng.int(24), rng.int(60)),
    ).toISOString();
  const now = new Date(nowIso);
  const storeMode: StoreMode = rng.chance(0.78)
    ? 'db'
    : rng.pick(['unreadable-db', 'pending-load', 'signed-out'] as const);
  const history = rng.pick([
    'empty',
    'single-today',
    'streak',
    'streak',
    'streak-at-risk',
    'dense-year',
    'ancient',
    'huge-day',
    'hostile-only',
  ] as const);
  const hostileStrings = rng.sample(HOSTILE_STRINGS, rng.range(1, 4));
  const hostileScores = rng.sample(HOSTILE_SCORES, rng.range(1, 3));
  const hostileInstants = rng.sample(HOSTILE_INSTANTS, rng.range(0, 2));
  const shots: ShotRow[] = [];
  const drills: DrillRecordRow[] = [];
  let counter = 0;
  const nextId = () => `stress-${seed}-${(counter += 1)}`;
  const pushShot = (daysBack: number, shotType: string) => {
    const score = rng.pick(hostileScores);
    shots.push({
      id: nextId(),
      sessionId: rng.chance(0.3) ? `session-${seed}-${rng.int(50)}` : null,
      shotType,
      capturedAt: localDayStartIso(now, timeZone, daysBack),
      overallScore: rng.chance(0.5) ? score.value : rng.range(0, 100) / 10,
      resultKind: rng.chance(0.5) ? score.resultKind : 'scored',
    });
  };
  const pushDrill = (daysBack: number, title: string) => {
    drills.push({
      id: nextId(),
      slug: rng.pick(hostileStrings).text || 'dink-ladder',
      title,
      completedAtIso: localDayStartIso(now, timeZone, daysBack),
    });
  };
  const techniques = ['dink', 'third_shot_drop', 'serve', 'drive', 'reset'];
  const hostileLabel = () => rng.pick(hostileStrings).text;
  switch (history) {
    case 'empty':
      break;
    case 'single-today':
      pushShot(0, rng.chance(0.5) ? hostileLabel() : rng.pick(techniques));
      break;
    case 'streak':
    case 'streak-at-risk': {
      const length = rng.range(1, 120);
      const start = history === 'streak-at-risk' ? 1 : 0;
      for (let d = start; d < start + length; d += 1) {
        // Occasional gap: shields bridge up to a few missed days.
        if (d > start && rng.chance(0.06)) continue;
        if (rng.chance(0.7)) pushShot(d, rng.pick(techniques));
        if (rng.chance(0.3)) pushDrill(d, hostileLabel());
      }
      break;
    }
    case 'dense-year': {
      const rows = rng.range(400, 1500);
      for (let i = 0; i < rows; i += 1) {
        pushShot(
          rng.int(400),
          rng.chance(0.2) ? hostileLabel() : rng.pick(techniques),
        );
      }
      break;
    }
    case 'ancient': {
      for (let i = 0; i < rng.range(3, 12); i += 1) {
        pushShot(rng.range(365 * 2, 365 * 7), rng.pick(techniques));
      }
      pushShot(0, hostileLabel());
      break;
    }
    case 'huge-day': {
      const rows = rng.range(150, 400);
      for (let i = 0; i < rows; i += 1) {
        pushShot(0, i % 7 === 0 ? hostileLabel() : rng.pick(techniques));
      }
      for (let i = 0; i < rng.range(5, 40); i += 1)
        pushDrill(0, hostileLabel());
      break;
    }
    case 'hostile-only': {
      for (const h of hostileStrings) {
        pushShot(rng.int(3), h.text);
        pushDrill(rng.int(3), h.text);
      }
      break;
    }
  }
  // Rows the engine must ignore: invalid instants, far future, empty types.
  for (const instant of hostileInstants) {
    shots.push({
      id: nextId(),
      sessionId: null,
      shotType: rng.pick(techniques),
      capturedAt: instant.capturedAt,
      overallScore: 5,
      resultKind: 'scored',
    });
    drills.push({
      id: nextId(),
      slug: 'ghost',
      title: hostileLabel(),
      completedAtIso: instant.capturedAt,
    });
  }
  const payloads = Array.from(
    new Set(
      [
        ...shots.map(s => s.shotType.replace(/_/g, ' ')),
        ...drills.map(d => d.title || d.slug),
      ].filter(text => text.length > 0),
    ),
  );
  const script: string[] = [];
  const prevPresses = rng.range(0, 4);
  for (let i = 0; i < prevPresses; i += 1) script.push('prev');
  if (rng.chance(0.5)) script.push('tap-counted-day');
  if (rng.chance(0.4)) script.push('tap-uncounted-day');
  for (let i = 0; i < rng.range(0, prevPresses + 1); i += 1)
    script.push('next');
  if (rng.chance(0.6)) script.push('tap-counted-day');
  if (rng.chance(0.3)) script.push('tap-same-day-again');
  if (storeMode === 'unreadable-db') script.unshift('retry');
  if (storeMode === 'pending-load') script.unshift('settle-load');
  script.push('back');
  return {
    variant: {
      seed,
      locale: rng.pick(LOCALES),
      timeZone,
      clockEdgeId: edge?.id ?? null,
      nowIso,
      width: rng.pick(WIDTHS),
      fontScale: rng.pick(FONT_SCALES),
      storeMode,
      history,
      shotRows: shots.length,
      drillRows: drills.length,
      hostileStringIds: hostileStrings.map(h => h.id),
      hostileScoreIds: hostileScores.map(h => h.id),
      hostileInstantIds: hostileInstants.map(h => h.id),
      script,
    },
    shots,
    drills,
    payloads,
  };
}

// ─── Harness ─────────────────────────────────────────────────────────────────

const Stack = createNativeStackNavigator();
const HOME_SENTINEL = 'STRESS_HOME_SENTINEL';
function HomeSentinel() {
  return (
    <View>
      <Text>{HOME_SENTINEL}</Text>
    </View>
  );
}

function renderInNavigator(): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <NavigationContainer
        initialState={{
          index: 1,
          routes: [{ name: 'Home' }, { name: 'StreakCalendar' }],
        }}
      >
        <Stack.Navigator>
          <Stack.Screen name="Home" component={HomeSentinel} />
          <Stack.Screen
            name="StreakCalendar"
            component={StreakCalendarScreen}
          />
        </Stack.Navigator>
      </NavigationContainer>,
    );
  });
  return renderer;
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
    });
  }
}

async function settleStore(
  predicate: () => boolean,
  budget = 40,
): Promise<boolean> {
  for (let i = 0; i < budget; i += 1) {
    if (predicate()) return true;
    await flush(1);
  }
  return predicate();
}

function seedDatabase(fixture: Fixture): void {
  const db = getDb(); // opens + runs production migrations
  const inner = mockSqlite.inner;
  if (!inner) throw new Error('sqlite not open');
  const owner = GUEST_DATA_OWNER;
  const insert = inner.prepare(
    `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at,
       overall_score, confidence, result_kind, source, favorite, payload)
     VALUES (?, ?, ?, ?, ?, ?, 0.9, ?, 'real', 0, '{}')`,
  );
  for (const shot of fixture.shots) {
    insert.run(
      owner,
      shot.id,
      shot.sessionId,
      shot.shotType,
      shot.capturedAt,
      shot.overallScore,
      shot.resultKind,
    );
  }
  if (fixture.drills.length > 0) {
    inner.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`).run(
      `consistency:${owner}`,
      JSON.stringify({
        version: 1,
        drills: fixture.drills,
        celebrated: {},
        daySecuredShownDay: null,
      }),
    );
  }
  void db;
}

/** RN `Pressable` composites (one per PressableScale/Button) carrying `label`. */
function pressablesByLabel(root: ReactTestInstance, label: string) {
  return root.findAll(
    n => isPressableNode(n) && n.props.accessibilityLabel === label,
  );
}

function dayCells(root: ReactTestInstance) {
  return root.findAll(
    n =>
      isPressableNode(n) &&
      typeof n.props.accessibilityLabel === 'string' &&
      /^\d{4}-\d{2}-\d{2}/.test(n.props.accessibilityLabel),
  );
}

function detailCards(root: ReactTestInstance) {
  return root.findAll(
    n => typeof n.type === 'string' && n.props.testID === 'streak-day-detail',
  );
}

/** The day whose cell exposes accessibilityState.selected === true, if any. */
function selectedDayOf(root: ReactTestInstance): string | null {
  const selected = dayCells(root).filter(
    c =>
      (c.props.accessibilityState as { selected?: boolean } | undefined)
        ?.selected === true,
  );
  if (selected.length > 1) return `MULTIPLE:${selected.length}`;
  const first = selected[0];
  return first ? (first.props.accessibilityLabel as string).slice(0, 10) : null;
}

function pressableWithText(root: ReactTestInstance, text: string) {
  return root.findAll(
    n => isPressableNode(n) && collectText(n).join('') === text,
  );
}

/** Press like RN would: a disabled Pressable never fires onPress. */
function press(node: ReactTestInstance): boolean {
  const disabled =
    node.props.disabled === true ||
    (node.props.accessibilityState as { disabled?: boolean } | undefined)
      ?.disabled === true;
  if (disabled) return false;
  act(() => {
    (node.props.onPress as () => void)();
  });
  return true;
}

function visibleMonthTitle(root: ReactTestInstance): string {
  // The month title is the only h3-styled Text between the two arrows; find
  // it as the Text sibling inside the row that holds "Previous month".
  const prev = pressablesByLabel(root, 'Previous month')[0];
  if (!prev) return '';
  let row: ReactTestInstance | null = prev.parent;
  while (
    row &&
    !(typeof row.type === 'string' && flatStyle(row)['flexDirection'] === 'row')
  ) {
    row = row.parent;
  }
  if (!row) return '';
  const texts = row.findAll(n => hostType(n) === 'Text');
  return texts
    .map(t => collectText(t).join(''))
    .join(' ')
    .trim();
}

const FORBIDDEN_TEXT = /\bNaN\b|\bundefined\b|\[object |Infinity|\bnull\b/;

interface RowInvariants {
  renders: boolean;
  everyPressableHasRole: boolean;
  everyPressableHasName: boolean;
  /** Controls with explicit width/height (Back, month arrows): effective
   * target (box + hitSlop) ≥ 44pt. Flex-sized controls are INFERRED below. */
  explicitControlsEffectiveTargetMeetsMin: boolean;
  disabledControlsExposeState: boolean;
  monthGridWellFormed: boolean;
  dayLabelsMatchSnapshot: boolean;
  todayCellMarked: boolean;
  payloadsRenderVerbatim: boolean;
  noForbiddenText: boolean;
  streakNumeralMatches: boolean;
  navigationArrowsRespectBounds: boolean;
  selectionToggleConsistent: boolean;
  backPopsToHome: boolean;
  errorStateAccessible: boolean;
  recoveryAfterRetry: boolean;
  localeStringsWellFormed: boolean;
}

interface RowInferred {
  dayCellVisualTargetMeetsMin: boolean | null;
  dayCellContentFits: boolean | null;
  dayNumberFitsWidth: boolean | null;
  geometry: ReturnType<typeof dayCellGeometry>;
  /** Explicit controls whose VISUAL box is < 44pt (hitSlop makes up the
   * effective target; recorded because the visual box is what a user sees). */
  explicitVisualBelowMin: string[];
  /** Flex-sized controls whose estimated effective target is < 44pt. */
  estimatedEffectiveBelowMin: string[];
  /** Controls whose size could not be derived from styles at all. */
  unknownSize: string[];
}

interface Row {
  seed: number;
  iteration: number;
  variant: Variant;
  observed: Record<string, unknown>;
  invariants: RowInvariants;
  inferred: RowInferred;
  ok: boolean;
  failed: string[];
  durationMs: number;
  error: string | null;
  evidenceFile: string | null;
}

function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress-streak-calendar');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function monthKeyOf(day: string): string {
  return day.slice(0, 7);
}

async function runIteration(iteration: number, seed: number): Promise<Row> {
  const started = Date.now();
  const fixture = generateFixture(seed);
  const { variant } = fixture;
  const inv: RowInvariants = {
    renders: false,
    everyPressableHasRole: true,
    everyPressableHasName: true,
    explicitControlsEffectiveTargetMeetsMin: true,
    disabledControlsExposeState: true,
    monthGridWellFormed: true,
    dayLabelsMatchSnapshot: true,
    todayCellMarked: true,
    payloadsRenderVerbatim: true,
    noForbiddenText: true,
    streakNumeralMatches: true,
    navigationArrowsRespectBounds: true,
    selectionToggleConsistent: true,
    backPopsToHome: true,
    errorStateAccessible: true,
    recoveryAfterRetry: true,
    localeStringsWellFormed: true,
  };
  const inferred: RowInferred = {
    dayCellVisualTargetMeetsMin: null,
    dayCellContentFits: null,
    dayNumberFitsWidth: null,
    geometry: null,
    explicitVisualBelowMin: [],
    estimatedEffectiveBelowMin: [],
    unknownSize: [],
  };
  const observed: Record<string, unknown> = {};
  let error: string | null = null;
  let evidenceFile: string | null = null;
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  const pressableSamples: PressableAudit[] = [];
  let renderedTexts: string[] = [];

  // Device + clock.
  device.locale = variant.locale;
  setWindow(variant.width, variant.fontScale);
  jest.useFakeTimers({
    now: new Date(variant.nowIso),
    doNotFake: [
      'setImmediate',
      'clearImmediate',
      'nextTick',
      'queueMicrotask',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
    ],
  });

  // Store + database.
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
  faults.executeThrows = false;
  faults.executePending = false;
  faults.pendingResolvers = [];
  setActiveDataOwner(
    variant.storeMode === 'signed-out'
      ? SIGNED_OUT_DATA_OWNER
      : GUEST_DATA_OWNER,
  );
  if (variant.storeMode !== 'signed-out') seedDatabase(fixture);
  if (variant.storeMode === 'unreadable-db') faults.executeThrows = true;
  if (variant.storeMode === 'pending-load') faults.executePending = true;

  try {
    renderer = renderInNavigator();
    const root = renderer.root;
    const state = () => useConsistencyStore.getState();

    if (variant.storeMode === 'db') {
      await settleStore(() => state().snapshot !== null);
    } else if (variant.storeMode === 'unreadable-db') {
      await settleStore(() => state().loadError);
    } else if (variant.storeMode === 'signed-out') {
      await settleStore(() => state().ownerKey === SIGNED_OUT_DATA_OWNER);
    } else {
      await flush(3);
    }
    inv.renders = true;

    const auditNow = (phase: string) => {
      const audits = auditPressables(root, variant.width, variant.fontScale);
      observed[`pressables:${phase}`] = audits.length;
      for (const a of audits) {
        if (!a.hasRole) inv.everyPressableHasRole = false;
        if (!a.hasNameForAt) inv.everyPressableHasName = false;
        const name = a.label ?? a.innerText;
        if (a.sizeSource === 'explicit') {
          if (a.effectiveMeetsMin === false) {
            inv.explicitControlsEffectiveTargetMeetsMin = false;
          }
          if (
            a.visualMeetsMin === false &&
            !inferred.explicitVisualBelowMin.includes(name)
          ) {
            inferred.explicitVisualBelowMin.push(name);
          }
        } else if (a.sizeSource === 'estimated') {
          if (a.effectiveMeetsMin === false) {
            const key = a.isDayCell
              ? `day-cell ~${a.estimatedWidth}x${a.estimatedHeight}`
              : `${name} ~${a.estimatedWidth}x${a.estimatedHeight}`;
            if (!inferred.estimatedEffectiveBelowMin.includes(key)) {
              inferred.estimatedEffectiveBelowMin.push(key);
            }
          }
        } else if (!inferred.unknownSize.includes(name)) {
          inferred.unknownSize.push(name);
        }
        if (a.disabled) {
          // The host must expose accessibilityState.disabled for AT.
          const host = root.findAll(
            n =>
              typeof n.type === 'string' &&
              n.props.accessibilityLabel === a.label,
          )[0];
          const st = host?.props.accessibilityState as
            { disabled?: boolean } | undefined;
          if (!st || st.disabled !== true)
            inv.disabledControlsExposeState = false;
        }
      }
      if (pressableSamples.length === 0) {
        pressableSamples.push(
          ...audits.filter(a => !a.isDayCell),
          ...audits.filter(a => a.isDayCell).slice(0, 3),
        );
      }
      const texts = auditTexts(root, fixture.payloads);
      const all = texts.map(t => t.text).join('\n');
      if (FORBIDDEN_TEXT.test(all)) {
        inv.noForbiddenText = false;
        observed[`forbiddenText:${phase}`] = all.match(FORBIDDEN_TEXT)?.[0];
        observed[`forbiddenTextNodes:${phase}`] = texts
          .filter(t => FORBIDDEN_TEXT.test(t.text))
          .map(t => t.text.slice(0, 80));
      }
      renderedTexts = texts.map(t => t.text.slice(0, 120));
      return { audits, texts };
    };

    // ── Error / pending / signed-out states ──────────────────────────────
    if (variant.storeMode === 'unreadable-db') {
      const alert = root.findAll(
        n =>
          typeof n.type === 'string' && n.props.accessibilityRole === 'alert',
      );
      const retry = new Set([
        ...pressablesByLabel(root, 'Try again'),
        ...pressableWithText(root, 'Try again'),
      ]);
      observed['errorAlertNodes'] = alert.length;
      observed['retryControls'] = retry.size;
      inv.errorStateAccessible = alert.length === 1 && retry.size === 1;
      auditNow('error');
    }
    if (
      variant.storeMode === 'pending-load' ||
      variant.storeMode === 'signed-out'
    ) {
      observed['snapshotNullState'] = state().snapshot === null;
      auditNow('null-snapshot');
      // With no snapshot the calendar anchors on the process-local today.
      const cells = dayCells(root);
      observed['nullStateDayCells'] = cells.length;
      if (cells.length === 0) inv.monthGridWellFormed = false;
    }

    // ── Interaction script ───────────────────────────────────────────────
    let lastTapped: string | null = null;
    let backPressed = false;
    for (const step of variant.script) {
      if (step === 'retry') {
        faults.executeThrows = false;
        const retry =
          pressablesByLabel(root, 'Try again')[0] ??
          pressableWithText(root, 'Try again')[0];
        if (!retry) {
          inv.recoveryAfterRetry = false;
          continue;
        }
        press(retry);
        const recovered = await settleStore(() => state().snapshot !== null);
        if (!recovered) inv.recoveryAfterRetry = false;
        continue;
      }
      if (step === 'settle-load') {
        faults.executePending = false;
        const resolvers = faults.pendingResolvers.splice(0);
        await act(async () => {
          for (const resolve of resolvers) resolve();
        });
        const settled = await settleStore(() => state().snapshot !== null);
        if (!settled) inv.recoveryAfterRetry = false;
        continue;
      }
      if (step === 'prev' || step === 'next') {
        const label = step === 'prev' ? 'Previous month' : 'Next month';
        const control = pressablesByLabel(root, label)[0];
        if (!control) {
          inv.navigationArrowsRespectBounds = false;
          continue;
        }
        const before = visibleMonthTitle(root);
        const fired = press(control);
        const after = visibleMonthTitle(root);
        if (fired && before === after)
          inv.navigationArrowsRespectBounds = false;
        if (!fired && before !== after)
          inv.navigationArrowsRespectBounds = false;
        continue;
      }
      if (step === 'tap-counted-day' || step === 'tap-uncounted-day') {
        const cells = dayCells(root);
        const wantCounted = step === 'tap-counted-day';
        const candidates = cells.filter(c => {
          const label = c.props.accessibilityLabel as string;
          const counted = /, (trained|shield protected)/.test(label);
          return counted === wantCounted;
        });
        const cell = candidates[Math.floor(candidates.length / 2)];
        if (!cell) continue;
        const day = (cell.props.accessibilityLabel as string).slice(0, 10);
        const wasSelected = selectedDayOf(root) === day;
        const fired = press(cell);
        if (wantCounted) {
          if (!fired) inv.dayLabelsMatchSnapshot = false;
          // A tap toggles: selected → cleared, otherwise → selected. The
          // detail card and the cell's accessibilityState.selected must agree.
          const nowSelected = selectedDayOf(root);
          const detailShown = detailCards(root).length === 1;
          if (wasSelected) {
            if (nowSelected !== null || detailShown)
              inv.selectionToggleConsistent = false;
            press(cell);
          } else if (nowSelected !== day || !detailShown) {
            inv.selectionToggleConsistent = false;
          }
          if (selectedDayOf(root) !== day)
            inv.selectionToggleConsistent = false;
          lastTapped = day;
          const snapshot = state().snapshot;
          const log = snapshot?.days[day];
          const texts = auditTexts(root, fixture.payloads);
          const rendered = texts.map(t => t.text).join('\n');
          if (log && !log.shielded) {
            for (const activity of log.activities) {
              if (!rendered.includes(activity.label)) {
                inv.payloadsRenderVerbatim = false;
                observed['missingLabel'] = activity.label.slice(0, 60);
              }
            }
            observed['selectedDayActivities'] = log.activities.length;
            const card = detailCards(root)[0];
            const cardTexts = card ? collectText(card) : [];
            observed['detailHeading'] = cardTexts[0] ?? null;
            observed['detailTimes'] = cardTexts
              .filter(
                t => /\d/.test(t) && !fixture.payloads.some(p => t.includes(p)),
              )
              .slice(1, 3);
            observed['activityLabelsSingleLine'] = texts
              .filter(t => t.carriesPayload)
              .every(t => t.numberOfLines === 1);
          }
        } else if (fired) {
          // An uncounted day is disabled: pressing must be a no-op.
          inv.dayLabelsMatchSnapshot = false;
        }
        continue;
      }
      if (step === 'tap-same-day-again' && lastTapped) {
        const cell = dayCells(root).find(c =>
          (c.props.accessibilityLabel as string).startsWith(
            lastTapped as string,
          ),
        );
        if (cell) {
          press(cell);
          const cleared =
            detailCards(root).length === 0 && selectedDayOf(root) === null;
          observed['deselectedAfterSecondTap'] = cleared;
          if (!cleared) inv.selectionToggleConsistent = false;
        }
        continue;
      }
      if (step === 'back') {
        const back = pressablesByLabel(root, 'Back')[0];
        if (!back) {
          inv.backPopsToHome = false;
          continue;
        }
        // Full audit of the final calendar state before leaving.
        const { audits } = auditNow('final');
        const snapshot = state().snapshot;
        const cells = dayCells(root);
        const month = visibleMonthTitle(root);
        observed['visibleMonth'] = month;
        observed['dayCells'] = cells.length;
        // Grid: every host week row holds exactly 7 aspect-ratio cells.
        const weekRows = root.findAll(
          n =>
            typeof n.type === 'string' &&
            flatStyle(n)['flexDirection'] === 'row' &&
            n.children.length === 7 &&
            n.children.every(c => {
              if (typeof c === 'string') return false;
              const h = firstHost(c);
              return h !== null && flatStyle(h)['aspectRatio'] !== undefined;
            }),
        );
        observed['weekRows'] = weekRows.length;
        if (
          weekRows.length < 4 ||
          weekRows.length > 6 ||
          cells.length < 28 ||
          cells.length > 31
        ) {
          inv.monthGridWellFormed = false;
        }
        if (snapshot) {
          const asOfMonth = monthKeyOf(snapshot.asOfDay);
          const cellMonth = cells[0]
            ? monthKeyOf(cells[0].props.accessibilityLabel as string)
            : null;
          observed['cellMonth'] = cellMonth;
          for (const cell of cells) {
            const label = cell.props.accessibilityLabel as string;
            const day = label.slice(0, 10);
            const log = snapshot.days[day];
            const isFuture = day > snapshot.asOfDay;
            const expected = log
              ? log.shielded
                ? `${day}, shield protected`
                : `${day}, trained, ${log.activities.length} ${
                    log.activities.length === 1 ? 'activity' : 'activities'
                  }`
              : isFuture
                ? day
                : `${day}, not trained`;
            if (label !== expected) {
              inv.dayLabelsMatchSnapshot = false;
              observed['labelMismatch'] = { label, expected };
              break;
            }
          }
          if (cellMonth === asOfMonth) {
            const todayCell = cells.find(c =>
              (c.props.accessibilityLabel as string).startsWith(
                snapshot.asOfDay,
              ),
            );
            const todayHost = todayCell ? firstHost(todayCell) : null;
            const border = todayHost
              ? flatStyle(todayHost)['borderWidth']
              : undefined;
            inv.todayCellMarked = typeof border === 'number' && border > 0;
          }
          // Hero numeral.
          const hero = root.findAll(
            n => typeof n.type === 'string' && n.props.testID === 'streak-hero',
          )[0];
          const heroText = hero ? collectText(hero) : [];
          inv.streakNumeralMatches = heroText.includes(
            String(snapshot.currentStreak),
          );
          observed['currentStreak'] = snapshot.currentStreak;
          observed['totalActivities'] = snapshot.totalActivities;
          observed['asOfDay'] = snapshot.asOfDay;
          observed['engineZone'] = snapshot.timeZone;
          if (snapshot.timeZone !== variant.timeZone)
            inv.localeStringsWellFormed = false;
        }
        // Locale-formatted strings must be non-empty and free of the raw key.
        const allText = auditTexts(root, fixture.payloads).map(t => t.text);
        const localized = allText.filter(t => /\d/.test(t) && t.length < 80);
        observed['sampleLocalizedText'] = localized.slice(0, 4);
        // Day-cell geometry (INFERRED) on the biggest icon case present.
        const dayAudits = audits.filter(a => a.isDayCell);
        const anyCounted = cells.find(c =>
          /, (trained|shield protected)/.test(
            c.props.accessibilityLabel as string,
          ),
        );
        const geomHost = firstHost(anyCounted ?? cells[0] ?? back);
        if (geomHost && cells.length > 0) {
          const geometry = dayCellGeometry(
            geomHost,
            variant.width,
            variant.fontScale,
          );
          inferred.geometry = geometry;
          if (geometry) {
            inferred.dayCellVisualTargetMeetsMin =
              geometry.innerWidth >= MIN_TARGET_PT &&
              geometry.innerHeight >= MIN_TARGET_PT;
            inferred.dayCellContentFits = geometry.contentFits;
            inferred.dayNumberFitsWidth = geometry.labelFits;
          }
        }
        observed['dayCellEffectiveTargetMeetsMin'] = dayAudits.every(
          a => a.effectiveMeetsMin !== false,
        );
        press(back);
        await flush(2);
        backPressed = true;
        const home = root.findAll(
          n =>
            typeof n.type === 'string' &&
            collectText(n).join('') === HOME_SENTINEL,
        );
        inv.backPopsToHome = home.length > 0;
        continue;
      }
    }
    if (!backPressed) inv.backPopsToHome = false;
  } catch (caught) {
    error =
      caught instanceof Error
        ? `${caught.name}: ${caught.message}`
        : String(caught);
  } finally {
    if (renderer) {
      try {
        act(() => renderer?.unmount());
      } catch (caught) {
        error = error ?? `unmount: ${String(caught)}`;
      }
    }
    faults.executeThrows = false;
    faults.executePending = false;
    for (const resolve of faults.pendingResolvers.splice(0)) resolve();
    try {
      if (mockSqlite.inner) getDb().close();
    } catch {
      // A database that never opened has nothing to close.
    }
    jest.useRealTimers();
  }

  const failed: string[] = (
    Object.keys(inv) as Array<keyof RowInvariants>
  ).filter(key => !inv[key]);
  if (error) failed.push('noThrow');
  const ok = failed.length === 0;
  if (
    !ok ||
    inferred.dayCellContentFits === false ||
    inferred.dayCellVisualTargetMeetsMin === false ||
    inferred.estimatedEffectiveBelowMin.length > 0
  ) {
    evidenceFile = path.join(artifactDir(), `evidence-seed-${seed}.json`);
    fs.writeFileSync(
      evidenceFile,
      JSON.stringify(
        {
          seed,
          variant,
          failed,
          error,
          inferred,
          pressables: pressableSamples,
          renderedTexts,
        },
        null,
        2,
      ) + '\n',
    );
  }
  observed['pressableSample'] = pressableSamples.slice(0, 6).map(a => ({
    label: a.label,
    role: a.role,
    size:
      a.sizeSource === 'explicit'
        ? `${a.explicitWidth}x${a.explicitHeight}`
        : a.sizeSource === 'estimated'
          ? `~${a.estimatedWidth}x${a.estimatedHeight}`
          : 'unknown',
    hitSlop: a.hitSlop.left,
    visualMeetsMin: a.visualMeetsMin,
    effectiveMeetsMin: a.effectiveMeetsMin,
  }));
  return {
    seed,
    iteration,
    variant,
    observed,
    invariants: inv,
    inferred,
    ok,
    failed,
    durationMs: Date.now() - started,
    error,
    evidenceFile,
  };
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const ITER = Math.max(1, Number(nodeProcess.env['STRESS_ITER'] ?? 24) || 24);
const BASE = Number(nodeProcess.env['STRESS_BASE'] ?? 20260905) || 20260905;
const ONLY_SEED = nodeProcess.env['STRESS_SEED']
  ? Number(nodeProcess.env['STRESS_SEED'])
  : null;
const ORIGINAL_WINDOW = realDimensionsGet('window');
const ORIGINAL_SCREEN = realDimensionsGet('screen');

beforeAll(() => {
  installDeviceLocale();
});

afterAll(() => {
  restoreDeviceLocale();
  Dimensions.set({ window: ORIGINAL_WINDOW, screen: ORIGINAL_SCREEN });
});

describe('StreakCalendarScreen boundary/i18n/a11y stress (real navigator + store + sqlite)', () => {
  jest.setTimeout(Math.max(120_000, ITER * 6_000));

  it(`campaign: ${ONLY_SEED !== null ? `seed ${ONLY_SEED}` : `${ITER} seeded variants`}`, async () => {
    const rows: Row[] = [];
    const seeds =
      ONLY_SEED !== null
        ? [ONLY_SEED]
        : Array.from({ length: ITER }, (_, i) => campaignSeed(BASE, i));
    for (let i = 0; i < seeds.length; i += 1) {
      rows.push(await runIteration(i, seeds[i] as number));
    }

    const byInvariant: Record<string, { checked: number; failed: number }> = {};
    for (const row of rows) {
      for (const [name, held] of Object.entries(row.invariants)) {
        const slot = (byInvariant[name] ??= { checked: 0, failed: 0 });
        slot.checked += 1;
        if (!held) slot.failed += 1;
      }
    }
    const inferredSummary = {
      dayCellVisualTargetMeetsMin: tally(
        rows.map(r => r.inferred.dayCellVisualTargetMeetsMin),
      ),
      dayCellContentFits: tally(rows.map(r => r.inferred.dayCellContentFits)),
      dayNumberFitsWidth: tally(rows.map(r => r.inferred.dayNumberFitsWidth)),
      explicitVisualBelowMin: count(
        rows.flatMap(r => r.inferred.explicitVisualBelowMin),
      ),
      estimatedEffectiveBelowMin: count(
        rows.flatMap(r => r.inferred.estimatedEffectiveBelowMin),
      ),
      unknownSize: count(rows.flatMap(r => r.inferred.unknownSize)),
      byWidthAndScale: groupInferred(rows),
    };
    const coverage = {
      locales: count(rows.map(r => r.variant.locale)),
      timeZones: count(rows.map(r => r.variant.timeZone)),
      clockEdges: count(rows.map(r => r.variant.clockEdgeId ?? 'random')),
      widths: count(rows.map(r => String(r.variant.width))),
      fontScales: count(rows.map(r => String(r.variant.fontScale))),
      storeModes: count(rows.map(r => r.variant.storeMode)),
      histories: count(rows.map(r => r.variant.history)),
      hostileStrings: count(rows.flatMap(r => r.variant.hostileStringIds)),
      hostileScores: count(rows.flatMap(r => r.variant.hostileScoreIds)),
      hostileInstants: count(rows.flatMap(r => r.variant.hostileInstantIds)),
      shotRowsTotal: rows.reduce((n, r) => n + r.variant.shotRows, 0),
      drillRowsTotal: rows.reduce((n, r) => n + r.variant.drillRows, 0),
    };
    const failedRows = rows.filter(r => !r.ok);
    const summary = {
      suite: 'streakCalendarScreen.boundaryI18nA11y.stress',
      node: nodeProcess.version,
      baseSeed: BASE,
      iterations: rows.length,
      passed: rows.length - failedRows.length,
      failed: failedRows.length,
      byInvariant,
      inferred: inferredSummary,
      coverage,
      failedSeeds: failedRows.map(r => ({
        seed: r.seed,
        failed: r.failed,
        error: r.error,
      })),
      totalMs: rows.reduce((n, r) => n + r.durationMs, 0),
    };
    const dir = artifactDir();
    const stamp =
      ONLY_SEED !== null
        ? `seed-${ONLY_SEED}`
        : `base-${BASE}-iter-${rows.length}`;
    fs.writeFileSync(
      path.join(dir, `rows-${stamp}.json`),
      JSON.stringify(rows, null, 2) + '\n',
    );
    fs.writeFileSync(
      path.join(dir, `summary-${stamp}.json`),
      JSON.stringify(summary, null, 2) + '\n',
    );

    expect(rows).toHaveLength(seeds.length);
    expect(
      failedRows.map(r => ({ seed: r.seed, failed: r.failed, error: r.error })),
    ).toEqual([]);
  });

  it('rendered-tree evidence: header/arrow/day-cell controls at every width × fontScale', async () => {
    // One deterministic, history-rich render per width × fontScale so the
    // tree evidence for the layout findings is reproducible without a seed.
    const evidence: unknown[] = [];
    for (const width of WIDTHS) {
      for (const fontScale of FONT_SCALES) {
        const seed = 0x5eed0000 + width * 10 + Math.round(fontScale * 1000);
        const row = await runIteration(-1, seed);
        const dir = artifactDir();
        evidence.push({
          width,
          fontScale,
          seed,
          storeMode: row.variant.storeMode,
          history: row.variant.history,
          inferred: row.inferred,
          pressableSample: row.observed['pressableSample'],
          ok: row.ok,
          failed: row.failed,
        });
        void dir;
      }
    }
    // Serialize one full month-grid host subtree (props + flattened styles).
    setWindow(375, 1);
    useConsistencyStore.setState({
      snapshot: null,
      loadError: false,
      ownerKey: null,
    });
    setActiveDataOwner(GUEST_DATA_OWNER);
    seedDatabase(generateFixture(campaignSeed(BASE, 0)));
    const renderer = renderInNavigator();
    await settleStore(() => useConsistencyStore.getState().snapshot !== null);
    const firstCell = dayCells(renderer.root)[0];
    const cellHost = firstCell ? firstHost(firstCell) : null;
    const weekRow = cellHost
      ? hostAncestor(cellHost, h => flatStyle(h)['flexDirection'] === 'row')
      : null;
    const gridEvidence = serializeHost(weekRow);
    const header = pressablesByLabel(renderer.root, 'Back')[0];
    const arrows = [
      ...pressablesByLabel(renderer.root, 'Previous month'),
      ...pressablesByLabel(renderer.root, 'Next month'),
    ];
    const treeFile = path.join(artifactDir(), 'rendered-tree-controls.json');
    fs.writeFileSync(
      treeFile,
      JSON.stringify(
        {
          note: 'react-test-renderer host subtree: props + flattened styles. No layout engine; sizes marked ~ are style arithmetic (INFERRED).',
          perWidthAndScale: evidence,
          back: serializeHost(header ? firstHost(header) : null),
          arrows: arrows.map(a => serializeHost(firstHost(a))),
          firstWeekRow: gridEvidence,
        },
        null,
        2,
      ) + '\n',
    );
    act(() => renderer.unmount());
    getDb().close();
    const snapshot: ConsistencySnapshot | null =
      useConsistencyStore.getState().snapshot;
    expect(snapshot).not.toBeNull();
    expect(evidence).toHaveLength(WIDTHS.length * FONT_SCALES.length);
    expect(evidence.every(e => (e as { ok: boolean }).ok)).toBe(true);
  });
});

function tally(values: Array<boolean | null>) {
  return {
    held: values.filter(v => v === true).length,
    failed: values.filter(v => v === false).length,
    unknown: values.filter(v => v === null).length,
  };
}

function count(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function groupInferred(rows: Row[]) {
  const out: Record<
    string,
    {
      rows: number;
      contentFits: number;
      visualTarget: number;
      numberFits: number;
      sample: unknown;
    }
  > = {};
  for (const row of rows) {
    if (row.inferred.geometry === null) continue;
    const key = `w${row.variant.width}@${row.variant.fontScale}`;
    const slot = (out[key] ??= {
      rows: 0,
      contentFits: 0,
      visualTarget: 0,
      numberFits: 0,
      sample: row.inferred.geometry,
    });
    slot.rows += 1;
    if (row.inferred.dayCellContentFits) slot.contentFits += 1;
    if (row.inferred.dayCellVisualTargetMeetsMin) slot.visualTarget += 1;
    if (row.inferred.dayNumberFitsWidth) slot.numberFits += 1;
  }
  return out;
}
