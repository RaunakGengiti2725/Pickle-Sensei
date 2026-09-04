/**
 * Failure-injection model for the HomeScreen stress harness
 * (`__tests__/stress/homeScreen.failureInjection.stress.test.tsx`).
 *
 * Everything here is deterministic and free of Jest globals so a scenario can
 * be reasoned about (and replayed) from its seed alone:
 *
 *   - `mulberry32(seed)`: the seeded RNG every random choice is drawn from;
 *   - the FAULT CATALOG: one entry per (dependency channel × fault mode) the
 *     rendered Home path can reach — SQLite open/migrate/reads/writes, the
 *     canonical progress + rank APIs, the notification native module, the
 *     clock/timezone, navigation round trips, and "poisoned" native modules
 *     Home must never touch (camera, Vision, TTS, RevenueCat, Keychain);
 *   - the ORACLE (`expectationFor`): what the screen must show for a fault
 *     set, derived from HomeScreen's documented contract, never from the run;
 *   - the SQLite shim that routes `op-sqlite` calls through a real
 *     `node:sqlite` database while applying armed faults per query channel;
 *   - the fetch fake for `/v1/progress` and `/v1/rank`;
 *   - the seeded local fixture (real `ShotAnalysis` payloads) and the
 *     persisted-state audit that proves nothing was corrupted.
 */
import type { ShotAnalysis } from '@pickle/shared-types';

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: items => {
      if (items.length === 0) throw new Error('pick() from an empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    chance: probability => next() < probability,
  };
}

// ---------------------------------------------------------------------------
// Fault model
// ---------------------------------------------------------------------------

export type SqliteChannel =
  | 'sqlite.open'
  | 'sqlite.migrate'
  | 'sqlite.listShots'
  | 'sqlite.listFacts'
  | 'sqlite.listActivity'
  | 'sqlite.kv.get.weekChart'
  | 'sqlite.kv.get.consistency'
  | 'sqlite.kv.get.notifications'
  | 'sqlite.kv.get.rankCelebration'
  | 'sqlite.kv.get.other'
  | 'sqlite.kv.set.weekChart'
  | 'sqlite.kv.set.other'
  | 'sqlite.other';

export type FetchChannel = 'fetch.progress' | 'fetch.rank';

export type NotifyChannel =
  'notify.settings' | 'notify.requestPermission' | 'notify.schedule';

export type ClockChannel = 'clock.timezone' | 'clock.skew';

export type PoisonChannel =
  | 'native.camera'
  | 'native.vision'
  | 'native.tts'
  | 'native.revenuecat'
  | 'native.keychain';

export type Channel =
  SqliteChannel | FetchChannel | NotifyChannel | ClockChannel | PoisonChannel;

export type FaultMode =
  | 'throw'
  | 'reject'
  | 'never'
  | 'slow'
  | 'malformed'
  | 'partial'
  | 'empty'
  | 'http500'
  | 'http401'
  | 'nonjson'
  | 'outOfRange'
  | 'denied'
  | 'skew';

export interface Fault {
  channel: Channel;
  mode: FaultMode;
  /** `slow`: latency in ms before the real result. */
  delayMs?: number;
  /** `malformed` / `partial` / `skew`: which corruption variant. */
  variant?: string;
}

export const SQLITE_READ_FAULT_MODES: readonly FaultMode[] = [
  'throw',
  'reject',
  'never',
  'slow',
  'malformed',
  'partial',
  'empty',
];

/** Row-shape corruptions applied to `listShots` results. */
export const LIST_SHOTS_MALFORMED_VARIANTS = [
  'capturedAtGarbage',
  'overallScoreText',
  'shotTypeNull',
  'idNull',
  'rowEmptyObject',
] as const;
export type ListShotsMalformedVariant =
  (typeof LIST_SHOTS_MALFORMED_VARIANTS)[number];

/** Payload corruptions applied to `listRealAnalysisFacts` rows. */
export const LIST_FACTS_MALFORMED_VARIANTS = [
  'payloadNotJson',
  'payloadWrongSource',
  'payloadMissingVersionVector',
  'payloadNull',
] as const;

export const KV_MALFORMED_VARIANTS = ['bogusWord', 'json', 'empty'] as const;

export const CLOCK_SKEW_VARIANTS = [
  'epoch1970',
  'year2099',
  'dstSpringForwardUS',
  'dstFallBackUS',
  'leapDay2028',
] as const;
export type ClockSkewVariant = (typeof CLOCK_SKEW_VARIANTS)[number];

export function clockSkewInstant(variant: ClockSkewVariant): string {
  switch (variant) {
    case 'epoch1970':
      return '1970-01-02T00:00:00.000Z';
    case 'year2099':
      return '2099-12-31T23:59:59.000Z';
    case 'dstSpringForwardUS':
      return '2026-03-08T09:59:59.000Z';
    case 'dstFallBackUS':
      return '2026-11-01T08:59:59.000Z';
    case 'leapDay2028':
      return '2028-02-29T12:00:00.000Z';
  }
}

export const TIMEZONE_VARIANTS = [
  'throwOnConstruct',
  'unsupportedZone',
] as const;

/**
 * The deterministic catalog: every injected fault the harness runs once
 * regardless of STRESS_ITER. Ordered so that the JSON table reads
 * dependency-by-dependency.
 */
export interface CatalogEntry {
  id: string;
  faults: Fault[];
  /** Signed-in (API session present) or guest — affects which fetches run. */
  session: 'guest' | 'signedIn';
  /** Post-load interaction the scenario drives. */
  interaction: Interaction;
}

export type Interaction =
  | 'none'
  | 'toggleWeekChart'
  | 'pullToRefresh'
  | 'streakCalendarRoundTrip'
  | 'openRecentResult'
  | 'notificationTurnOn'
  | 'notificationNotNow';

const READ_CHANNELS: readonly SqliteChannel[] = [
  'sqlite.listShots',
  'sqlite.listFacts',
];

export function buildCatalog(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const add = (
    id: string,
    faults: Fault[],
    session: CatalogEntry['session'] = 'guest',
    interaction: Interaction = 'none',
  ) => entries.push({ id, faults, session, interaction });

  // --- SQLite: database open / migration ----------------------------------
  add('sqlite.open.throw', [{ channel: 'sqlite.open', mode: 'throw' }]);
  add('sqlite.migrate.throw', [{ channel: 'sqlite.migrate', mode: 'throw' }]);

  // --- SQLite: the two reads whose failure fails the court -----------------
  for (const channel of READ_CHANNELS) {
    add(`${channel}.throw`, [{ channel, mode: 'throw' }]);
    add(`${channel}.reject`, [{ channel, mode: 'reject' }]);
    add(`${channel}.never`, [{ channel, mode: 'never' }]);
    add(`${channel}.slow.1500`, [{ channel, mode: 'slow', delayMs: 1500 }]);
    add(`${channel}.slow.20000`, [{ channel, mode: 'slow', delayMs: 20_000 }]);
    add(`${channel}.empty`, [{ channel, mode: 'empty' }]);
    add(`${channel}.partial`, [{ channel, mode: 'partial' }]);
  }
  for (const variant of LIST_SHOTS_MALFORMED_VARIANTS) {
    add(`sqlite.listShots.malformed.${variant}`, [
      { channel: 'sqlite.listShots', mode: 'malformed', variant },
    ]);
  }
  for (const variant of LIST_FACTS_MALFORMED_VARIANTS) {
    add(`sqlite.listFacts.malformed.${variant}`, [
      { channel: 'sqlite.listFacts', mode: 'malformed', variant },
    ]);
  }
  add('sqlite.listShots+listFacts.reject', [
    { channel: 'sqlite.listShots', mode: 'reject' },
    { channel: 'sqlite.listFacts', mode: 'reject' },
  ]);
  add('sqlite.listShots.reject.retryStillFailing', [
    { channel: 'sqlite.listShots', mode: 'reject' },
  ]);

  // --- SQLite: KV reads/writes Home uses directly or via its stores --------
  add('sqlite.kv.get.weekChart.throw', [
    { channel: 'sqlite.kv.get.weekChart', mode: 'throw' },
  ]);
  add('sqlite.kv.get.weekChart.reject', [
    { channel: 'sqlite.kv.get.weekChart', mode: 'reject' },
  ]);
  add('sqlite.kv.get.weekChart.never', [
    { channel: 'sqlite.kv.get.weekChart', mode: 'never' },
  ]);
  for (const variant of KV_MALFORMED_VARIANTS) {
    add(`sqlite.kv.get.weekChart.malformed.${variant}`, [
      { channel: 'sqlite.kv.get.weekChart', mode: 'malformed', variant },
    ]);
  }
  add(
    'sqlite.kv.set.weekChart.reject',
    [{ channel: 'sqlite.kv.set.weekChart', mode: 'reject' }],
    'guest',
    'toggleWeekChart',
  );
  add(
    'sqlite.kv.set.weekChart.throw',
    [{ channel: 'sqlite.kv.set.weekChart', mode: 'throw' }],
    'guest',
    'toggleWeekChart',
  );
  add(
    'sqlite.kv.set.weekChart.never',
    [{ channel: 'sqlite.kv.set.weekChart', mode: 'never' }],
    'guest',
    'toggleWeekChart',
  );
  add('sqlite.kv.get.consistency.reject', [
    { channel: 'sqlite.kv.get.consistency', mode: 'reject' },
  ]);
  add('sqlite.kv.get.consistency.malformed', [
    {
      channel: 'sqlite.kv.get.consistency',
      mode: 'malformed',
      variant: 'json',
    },
  ]);
  add('sqlite.kv.get.notifications.reject', [
    { channel: 'sqlite.kv.get.notifications', mode: 'reject' },
  ]);
  add('sqlite.kv.get.notifications.malformed', [
    {
      channel: 'sqlite.kv.get.notifications',
      mode: 'malformed',
      variant: 'bogusWord',
    },
  ]);
  add('sqlite.kv.get.rankCelebration.reject', [
    { channel: 'sqlite.kv.get.rankCelebration', mode: 'reject' },
  ]);
  add('sqlite.kv.set.other.reject', [
    { channel: 'sqlite.kv.set.other', mode: 'reject' },
  ]);
  add('sqlite.listActivity.reject', [
    { channel: 'sqlite.listActivity', mode: 'reject' },
  ]);
  add('sqlite.listActivity.never', [
    { channel: 'sqlite.listActivity', mode: 'never' },
  ]);
  add('sqlite.listActivity.malformed', [
    {
      channel: 'sqlite.listActivity',
      mode: 'malformed',
      variant: 'capturedAtGarbage',
    },
  ]);

  // --- fetch: canonical progress (signed in) --------------------------------
  const progressModes: FaultMode[] = [
    'reject',
    'http500',
    'http401',
    'nonjson',
    'malformed',
    'partial',
    'outOfRange',
    'never',
  ];
  for (const mode of progressModes) {
    add(
      `fetch.progress.${mode}`,
      [{ channel: 'fetch.progress', mode }],
      'signedIn',
    );
  }
  add(
    'fetch.progress.slow.3000',
    [{ channel: 'fetch.progress', mode: 'slow', delayMs: 3000 }],
    'signedIn',
  );
  add(
    'fetch.progress.slow.14000',
    [{ channel: 'fetch.progress', mode: 'slow', delayMs: 14_000 }],
    'signedIn',
  );

  // --- fetch: account rank (signed in) --------------------------------------
  const rankModes: FaultMode[] = [
    'reject',
    'http500',
    'nonjson',
    'malformed',
    'outOfRange',
    'never',
  ];
  for (const mode of rankModes) {
    add(`fetch.rank.${mode}`, [{ channel: 'fetch.rank', mode }], 'signedIn');
  }
  add(
    'fetch.rank.slow.5000',
    [{ channel: 'fetch.rank', mode: 'slow', delayMs: 5000 }],
    'signedIn',
  );
  add(
    'fetch.progress+rank.reject',
    [
      { channel: 'fetch.progress', mode: 'reject' },
      { channel: 'fetch.rank', mode: 'reject' },
    ],
    'signedIn',
  );
  add(
    'fetch.progress.never+sqlite.listShots.reject',
    [
      { channel: 'fetch.progress', mode: 'never' },
      { channel: 'sqlite.listShots', mode: 'reject' },
    ],
    'signedIn',
  );

  // --- notifications: permission + scheduling ------------------------------
  add('notify.settings.reject', [
    { channel: 'notify.settings', mode: 'reject' },
  ]);
  add('notify.settings.malformed', [
    { channel: 'notify.settings', mode: 'malformed' },
  ]);
  add(
    'notify.requestPermission.reject',
    [{ channel: 'notify.requestPermission', mode: 'reject' }],
    'guest',
    'notificationTurnOn',
  );
  add(
    'notify.requestPermission.denied',
    [{ channel: 'notify.requestPermission', mode: 'denied' }],
    'guest',
    'notificationTurnOn',
  );
  add(
    'notify.requestPermission.slow.60000',
    [{ channel: 'notify.requestPermission', mode: 'slow', delayMs: 60_000 }],
    'guest',
    'notificationTurnOn',
  );
  add(
    'notify.requestPermission.malformed',
    [{ channel: 'notify.requestPermission', mode: 'malformed' }],
    'guest',
    'notificationTurnOn',
  );
  add(
    'notify.schedule.reject',
    [{ channel: 'notify.schedule', mode: 'reject' }],
    'guest',
    'notificationTurnOn',
  );
  add(
    'notify.notNow+sqlite.kv.set.other.reject',
    [{ channel: 'sqlite.kv.set.other', mode: 'reject' }],
    'guest',
    'notificationNotNow',
  );

  // --- clock ----------------------------------------------------------------
  for (const variant of CLOCK_SKEW_VARIANTS) {
    add(`clock.skew.${variant}`, [
      { channel: 'clock.skew', mode: 'skew', variant },
    ]);
  }
  for (const variant of TIMEZONE_VARIANTS) {
    add(`clock.timezone.${variant}`, [
      { channel: 'clock.timezone', mode: 'malformed', variant },
    ]);
  }

  // --- navigation round trips under faults ---------------------------------
  add(
    'navigation.streakCalendar.roundTrip+sqlite.listActivity.reject',
    [{ channel: 'sqlite.listActivity', mode: 'reject' }],
    'guest',
    'streakCalendarRoundTrip',
  );
  add(
    'navigation.streakCalendar.roundTrip+sqlite.listShots.reject',
    [{ channel: 'sqlite.listShots', mode: 'reject' }],
    'guest',
    'streakCalendarRoundTrip',
  );
  add(
    'navigation.openRecentResult+sqlite.other.reject',
    [{ channel: 'sqlite.other', mode: 'reject' }],
    'guest',
    'openRecentResult',
  );
  add(
    'navigation.pullToRefresh+sqlite.listShots.reject',
    [{ channel: 'sqlite.listShots', mode: 'reject' }],
    'guest',
    'pullToRefresh',
  );
  add(
    'navigation.pullToRefresh+fetch.progress.reject',
    [{ channel: 'fetch.progress', mode: 'reject' }],
    'signedIn',
    'pullToRefresh',
  );

  // --- native modules Home must never touch ---------------------------------
  const poison: PoisonChannel[] = [
    'native.camera',
    'native.vision',
    'native.tts',
    'native.revenuecat',
    'native.keychain',
  ];
  for (const channel of poison) {
    add(`${channel}.throw`, [{ channel, mode: 'throw' }]);
  }
  add(
    'native.all.throw+signedIn',
    poison.map(channel => ({ channel, mode: 'throw' as const })),
    'signedIn',
  );

  return entries;
}

/**
 * Random campaign entry (STRESS_ITER): one or two catalog faults drawn from
 * the seed, plus a seeded fixture size, session and interaction.
 */
export function randomCatalogEntry(
  seed: number,
  catalog: readonly CatalogEntry[],
): CatalogEntry {
  const rng = mulberry32(seed);
  const first = rng.pick(catalog);
  const faults = [...first.faults];
  if (rng.chance(0.4)) {
    const second = rng.pick(catalog);
    for (const fault of second.faults) {
      if (!faults.some(f => f.channel === fault.channel)) faults.push(fault);
    }
  }
  const session: CatalogEntry['session'] = rng.chance(0.5)
    ? 'signedIn'
    : 'guest';
  const interactions: Interaction[] = [
    'none',
    'toggleWeekChart',
    'pullToRefresh',
    'streakCalendarRoundTrip',
    'openRecentResult',
  ];
  return {
    id: `random.${seed}`,
    faults,
    session,
    interaction: rng.pick(interactions),
  };
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

export type LoadExpectation =
  /** Court renders with the seeded local data. */
  | 'court'
  /** Visible ErrorState with a "Try again" control; recovers once cleared. */
  | 'error-retry'
  /** Primary local read hangs: no data can honestly be shown. */
  | 'hang';

const FATAL_LOCAL: ReadonlySet<string> = new Set([
  'sqlite.open:throw',
  'sqlite.migrate:throw',
  'sqlite.listShots:throw',
  'sqlite.listShots:reject',
  'sqlite.listFacts:throw',
  'sqlite.listFacts:reject',
]);

const HANG_LOCAL: ReadonlySet<string> = new Set([
  'sqlite.listShots:never',
  'sqlite.listFacts:never',
  'sqlite.kv.get.weekChart:never',
]);

export function expectationFor(faults: readonly Fault[]): LoadExpectation {
  const keys = faults.map(f => `${f.channel}:${f.mode}`);
  if (keys.some(k => FATAL_LOCAL.has(k))) return 'error-retry';
  if (keys.some(k => HANG_LOCAL.has(k))) return 'hang';
  return 'court';
}

/** Latency the oracle allows before the court (or its error) must be up. */
export function expectedLocalLatencyMs(faults: readonly Fault[]): number {
  let latency = 0;
  for (const fault of faults) {
    if (fault.mode === 'slow' && fault.channel.startsWith('sqlite.')) {
      latency = Math.max(latency, fault.delayMs ?? 0);
    }
  }
  return latency;
}

// ---------------------------------------------------------------------------
// SQLite shim: real node:sqlite behind op-sqlite's surface, faults per channel
// ---------------------------------------------------------------------------

export interface NodeSqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
  run(...params: (string | number | null)[]): unknown;
}
export interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
  close(): void;
}

export const WEEK_CHART_KV_KEY = 'home.week-chart';

export function classifySql(
  sql: string,
  params: readonly unknown[],
): SqliteChannel {
  const flat = sql.replace(/\s+/g, ' ');
  if (/SELECT value FROM kv WHERE key = \?/.test(flat)) {
    const key = String(params[0] ?? '');
    if (key === WEEK_CHART_KV_KEY) return 'sqlite.kv.get.weekChart';
    if (key.startsWith('consistency')) return 'sqlite.kv.get.consistency';
    if (key.startsWith('notifications')) return 'sqlite.kv.get.notifications';
    if (key.startsWith('rank.celebrated'))
      return 'sqlite.kv.get.rankCelebration';
    return 'sqlite.kv.get.other';
  }
  if (/INSERT OR REPLACE INTO kv/.test(flat)) {
    return String(params[0] ?? '') === WEEK_CHART_KV_KEY
      ? 'sqlite.kv.set.weekChart'
      : 'sqlite.kv.set.other';
  }
  if (
    /SELECT payload FROM local_shot/.test(flat) &&
    /ORDER BY captured_at DESC/.test(flat)
  ) {
    return 'sqlite.listFacts';
  }
  if (/FROM local_shot/.test(flat) && /favorite/.test(flat)) {
    return 'sqlite.listShots';
  }
  if (/FROM local_shot/.test(flat) && /ORDER BY captured_at ASC/.test(flat)) {
    return 'sqlite.listActivity';
  }
  return 'sqlite.other';
}

export interface SqliteCall {
  channel: SqliteChannel;
  mode: FaultMode | 'passthrough';
  atMs: number;
}

export interface FaultController {
  /** Faults currently armed; cleared by `clear()` for recovery phases. */
  readonly faults: Fault[];
  arm(faults: readonly Fault[]): void;
  clear(channelPrefix?: string): void;
  faultFor(channel: Channel): Fault | undefined;
  /** Every SQLite call routed through the shim (channel + applied mode). */
  readonly sqliteCalls: SqliteCall[];
  readonly fetchCalls: Array<{
    channel: FetchChannel | 'fetch.other';
    mode: string;
  }>;
  readonly poisonCalls: Array<{ channel: PoisonChannel; member: string }>;
  /** The real database behind the shim (swapped per scenario). */
  real: NodeSqliteDatabase | null;
  /** Wall clock used for call timestamps (Date.now under fake timers). */
  now: () => number;
}

export function createFaultController(): FaultController {
  const faults: Fault[] = [];
  return {
    faults,
    arm(next) {
      for (const fault of next) {
        const index = faults.findIndex(f => f.channel === fault.channel);
        if (index >= 0) faults.splice(index, 1);
        faults.push({ ...fault });
      }
    },
    clear(channelPrefix) {
      for (let i = faults.length - 1; i >= 0; i--) {
        const fault = faults[i]!;
        if (!channelPrefix || fault.channel.startsWith(channelPrefix)) {
          faults.splice(i, 1);
        }
      }
    },
    faultFor(channel) {
      return faults.find(f => f.channel === channel);
    },
    sqliteCalls: [],
    fetchCalls: [],
    poisonCalls: [],
    real: null,
    now: () => Date.now(),
  };
}

export class InjectedFaultError extends Error {
  constructor(channel: string, mode: string) {
    super(`injected ${mode} on ${channel}`);
    this.name = 'InjectedFaultError';
  }
}

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function corruptListShotsRows(
  rows: Record<string, unknown>[],
  variant: string | undefined,
): Record<string, unknown>[] {
  if (rows.length === 0) return rows;
  return rows.map((row, index) => {
    if (index !== 0) return row;
    switch (variant) {
      case 'capturedAtGarbage':
        return { ...row, captured_at: 'not-a-date' };
      case 'overallScoreText':
        return { ...row, overall_score: 'seven-ish' };
      case 'shotTypeNull':
        return { ...row, shot_type: null };
      case 'idNull':
        return { ...row, id: null };
      case 'rowEmptyObject':
        return {};
      default:
        return { ...row, captured_at: 'not-a-date' };
    }
  });
}

function corruptListFactsRows(
  rows: Record<string, unknown>[],
  variant: string | undefined,
): Record<string, unknown>[] {
  if (rows.length === 0) return rows;
  return rows.map((row, index) => {
    if (index !== 0) return row;
    const payload = String(row['payload'] ?? '{}');
    switch (variant) {
      case 'payloadNotJson':
        return { payload: '{"id":"trunc' };
      case 'payloadWrongSource': {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        return { payload: JSON.stringify({ ...parsed, source: 'synthetic' }) };
      }
      case 'payloadMissingVersionVector': {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        delete parsed['versionVector'];
        return { payload: JSON.stringify(parsed) };
      }
      case 'payloadNull':
        return { payload: null };
      default:
        return { payload: '{"id":"trunc' };
    }
  });
}

function corruptKvValue(variant: string | undefined): string {
  switch (variant) {
    case 'json':
      return '{"unexpected":true}';
    case 'empty':
      return '';
    default:
      return 'bogus-value';
  }
}

/**
 * op-sqlite's `open()` surface, honouring armed faults. `executeSync` covers
 * migrations (channel `sqlite.migrate`); `execute` covers every runtime read
 * and write.
 */
export function createOpSqliteShim(ctl: FaultController) {
  return {
    open: () => {
      const openFault = ctl.faultFor('sqlite.open');
      if (openFault?.mode === 'throw') {
        throw new InjectedFaultError('sqlite.open', 'throw');
      }
      const real = () => {
        if (!ctl.real) throw new Error('stress shim: no database installed');
        return ctl.real;
      };
      return {
        executeSync: (sql: string) => {
          const migrateFault = ctl.faultFor('sqlite.migrate');
          if (migrateFault?.mode === 'throw') {
            throw new InjectedFaultError('sqlite.migrate', 'throw');
          }
          return { rows: real().prepare(sql).all() };
        },
        execute: (sql: string, params: unknown[] = []) => {
          const channel = classifySql(sql, params);
          const fault = ctl.faultFor(channel);
          const mode = fault?.mode ?? 'passthrough';
          ctl.sqliteCalls.push({ channel, mode, atMs: ctl.now() });
          const runReal = () => ({
            rows: real()
              .prepare(sql)
              .all(...(params as (string | number | null)[])),
          });
          if (!fault) return Promise.resolve(runReal());
          switch (fault.mode) {
            case 'throw':
              throw new InjectedFaultError(channel, 'throw');
            case 'reject':
              return Promise.reject(new InjectedFaultError(channel, 'reject'));
            case 'never':
              return neverSettles<{ rows: Record<string, unknown>[] }>();
            case 'slow':
              return new Promise<{ rows: Record<string, unknown>[] }>(
                (resolve, reject) => {
                  setTimeout(() => {
                    try {
                      resolve(runReal());
                    } catch (error) {
                      reject(error);
                    }
                  }, fault.delayMs ?? 1000);
                },
              );
            case 'empty':
              return Promise.resolve({ rows: [] });
            case 'partial': {
              const { rows } = runReal();
              return Promise.resolve({
                rows: rows.slice(0, Math.max(0, Math.floor(rows.length / 2))),
              });
            }
            case 'malformed': {
              if (
                channel === 'sqlite.listShots' ||
                channel === 'sqlite.listActivity'
              ) {
                return Promise.resolve({
                  rows: corruptListShotsRows(runReal().rows, fault.variant),
                });
              }
              if (channel === 'sqlite.listFacts') {
                return Promise.resolve({
                  rows: corruptListFactsRows(runReal().rows, fault.variant),
                });
              }
              if (channel.startsWith('sqlite.kv.get')) {
                return Promise.resolve({
                  rows: [{ value: corruptKvValue(fault.variant) }],
                });
              }
              return Promise.resolve(runReal());
            }
            default:
              return Promise.resolve(runReal());
          }
        },
        close: () => {},
      };
    },
  };
}

// ---------------------------------------------------------------------------
// fetch fake: /v1/progress and /v1/rank
// ---------------------------------------------------------------------------

export const API_BASE_URL = 'https://stress.invalid/functions/v1/api';

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

function jsonResponse(status: number, payload: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function nonJsonResponse(status: number): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
    text: async () => '<html>gateway</html>',
  };
}

export function goodProgressPayload(dayIso: string): unknown {
  return {
    series: [
      {
        day: dayIso.slice(0, 10),
        shot_type: 'forehand_drive',
        scoring_model_version: 'score-1',
        shot_count: 3,
        avg_score: 71,
        best_score: 80,
      },
    ],
    improving: [{ checkpoint: 'preparation', delta: 0.4 }],
    needsAttention: [{ checkpoint: 'contact_position', avg: 5.1 }],
    streak: {
      currentDays: 2,
      longestDays: 4,
      practicedToday: true,
      lastPracticeDate: dayIso.slice(0, 10),
    },
  };
}

export function goodRankPayload(dayIso: string): unknown {
  return {
    rank: {
      rating: 6.4,
      tier: 'contender',
      techniqueCount: 2,
      techniques: [
        { shot_type: 'forehand_drive', score: 6.8, captured_at: dayIso },
        { shot_type: 'backhand_dink', score: 6.0, captured_at: dayIso },
      ],
    },
  };
}

function payloadFor(
  channel: FetchChannel,
  mode: FaultMode | 'good',
  dayIso: string,
): FakeResponse {
  const good =
    channel === 'fetch.progress'
      ? goodProgressPayload(dayIso)
      : goodRankPayload(dayIso);
  switch (mode) {
    case 'http500':
      return jsonResponse(500, { error: 'internal' });
    case 'http401':
      return jsonResponse(401, { error: 'unauthorized' });
    case 'nonjson':
      return nonJsonResponse(200);
    case 'malformed':
      return jsonResponse(
        200,
        channel === 'fetch.progress'
          ? { series: 'nope', improving: null, needsAttention: 3, streak: [] }
          : { rank: { rating: 'high', techniques: 'many' } },
      );
    case 'partial':
      return jsonResponse(
        200,
        channel === 'fetch.progress'
          ? { series: [], improving: [], needsAttention: [] }
          : {},
      );
    case 'outOfRange':
      return jsonResponse(
        200,
        channel === 'fetch.progress'
          ? {
              ...(goodProgressPayload(dayIso) as Record<string, unknown>),
              series: [
                {
                  day: dayIso.slice(0, 10),
                  shot_type: 'forehand_drive',
                  scoring_model_version: 'score-1',
                  shot_count: 1,
                  avg_score: 5000,
                  best_score: -40,
                },
              ],
            }
          : {
              rank: {
                rating: 42,
                tier: 'contender',
                techniqueCount: 1,
                techniques: [],
              },
            },
      );
    default:
      return jsonResponse(200, good);
  }
}

export function createFetchFake(ctl: FaultController, dayIso: string) {
  return (
    input: unknown,
    init?: { signal?: AbortSignal },
  ): Promise<FakeResponse> => {
    const url = typeof input === 'string' ? input : String(input);
    const channel: FetchChannel | 'fetch.other' = url.endsWith('/v1/progress')
      ? 'fetch.progress'
      : url.endsWith('/v1/rank')
        ? 'fetch.rank'
        : 'fetch.other';
    if (channel === 'fetch.other') {
      ctl.fetchCalls.push({ channel, mode: 'http404' });
      return Promise.resolve(jsonResponse(404, { error: 'not found' }));
    }
    const fault = ctl.faultFor(channel);
    const mode = fault?.mode ?? 'good';
    ctl.fetchCalls.push({ channel, mode });
    switch (mode) {
      case 'reject':
        return Promise.reject(new TypeError('Network request failed'));
      case 'never':
        return new Promise<FakeResponse>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            const onAbort = () => {
              const error = new Error('Aborted');
              error.name = 'AbortError';
              reject(error);
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort);
          }
        });
      case 'slow':
        return new Promise<FakeResponse>(resolve => {
          setTimeout(
            () => resolve(payloadFor(channel, 'good', dayIso)),
            fault?.delayMs ?? 1000,
          );
        });
      default:
        return Promise.resolve(payloadFor(channel, mode, dayIso));
    }
  };
}

// ---------------------------------------------------------------------------
// Fixture: seeded real ShotAnalysis rows
// ---------------------------------------------------------------------------

export const SHOT_TYPES = [
  'forehand_drive',
  'backhand_drive',
  'forehand_dink',
  'backhand_dink',
  'third_shot_drop',
  'serve',
] as const;

export const CHECKPOINTS = [
  'preparation',
  'paddle_set',
  'contact_position',
  'follow_through',
] as const;

export interface SeededShot {
  analysis: ShotAnalysis;
}

/**
 * Deterministic local history: `count` real analyses spread over the last
 * `spanDays` days, most scored, some low-confidence abstentions. Uses the
 * shared-types shape exactly as `saveAnalysis` persists it.
 */
export function seedShots(
  rng: Rng,
  nowIso: string,
  count: number,
  spanDays = 12,
): SeededShot[] {
  const nowMs = Date.parse(nowIso);
  const shots: SeededShot[] = [];
  for (let i = 0; i < count; i++) {
    const ageMs = Math.floor(rng.next() * spanDays * 86_400_000);
    const capturedAtIso = new Date(nowMs - ageMs).toISOString();
    const shotType = rng.pick(SHOT_TYPES);
    const scored = rng.chance(0.8);
    const overallScore = scored ? Math.round(rng.next() * 100) / 10 : null;
    const checkpoints = CHECKPOINTS.map(key => ({
      key,
      label: key.replace(/_/g, ' '),
      score: scored ? Math.round(rng.next() * 100) / 10 : null,
      applicable: true,
      evidence: [],
      confidence: 0.9,
    }));
    const analysis = {
      id: `stress-${i.toString().padStart(3, '0')}-${Math.floor(
        rng.next() * 1e9,
      )
        .toString(16)
        .padStart(8, '0')}`,
      sessionId: null,
      shotType,
      cameraView: 'side',
      handedness: 'right',
      capturedAtIso,
      timestamps: { startMs: 0, contactMs: 900, endMs: 1800 },
      phases: [],
      measurements: [],
      checkpoints,
      overallScore,
      analysisConfidence: scored ? 0.9 : 0.3,
      resultKind: scored ? 'scored' : 'low_confidence',
      guidance: scored ? null : 'Move the phone further back.',
      priorityFix: scored
        ? {
            checkpoint: rng.pick(CHECKPOINTS),
            title: 'Set the paddle earlier',
            cue: 'Paddle back before the bounce.',
            drillId: null,
          }
        : null,
      versionVector: {
        appVersion: '0.1.0',
        modelBundleVersion: 'validated-bundle-1',
        poseModelVersion: 'pose-1',
        paddleModelVersion: 'paddle-1',
        strokeDetectorVersion: 'stroke-1',
        phaseModelVersion: 'phase-1',
        scoringModelVersion: 'score-1',
        shotConfigVersion: `${shotType}@1`,
      },
      source: 'real',
    } as unknown as ShotAnalysis;
    shots.push({ analysis });
  }
  return shots;
}

export function insertSeededShots(
  db: NodeSqliteDatabase,
  owner: string,
  shots: readonly SeededShot[],
): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO local_shot
     (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const { analysis } of shots) {
    stmt.run(
      owner,
      analysis.id,
      analysis.sessionId,
      analysis.shotType,
      analysis.capturedAtIso,
      analysis.overallScore,
      analysis.analysisConfidence,
      analysis.resultKind,
      analysis.source,
      JSON.stringify(analysis),
    );
  }
}

// ---------------------------------------------------------------------------
// Persisted-state audit
// ---------------------------------------------------------------------------

export interface PersistedSnapshot {
  integrity: string;
  localShots: string;
  kv: Record<string, string>;
}

export function snapshotPersisted(db: NodeSqliteDatabase): PersistedSnapshot {
  const integrityRows = db.prepare('PRAGMA integrity_check').all();
  const integrity = integrityRows
    .map(row => String(Object.values(row)[0] ?? ''))
    .join(',');
  const localShots = JSON.stringify(
    db
      .prepare(
        `SELECT owner_key, id, session_id, shot_type, captured_at, overall_score,
                confidence, result_kind, source, favorite, payload
         FROM local_shot ORDER BY owner_key, id`,
      )
      .all(),
  );
  const kv: Record<string, string> = {};
  for (const row of db
    .prepare('SELECT key, value FROM kv ORDER BY key')
    .all()) {
    kv[String(row['key'])] = String(row['value']);
  }
  return { integrity, localShots, kv };
}

export interface PersistedAudit {
  ok: boolean;
  problems: string[];
  kvKeysAfter: string[];
}

/** Known KV namespaces Home's render path may legitimately write. */
function kvValueValid(key: string, value: string): string | null {
  if (key === WEEK_CHART_KV_KEY) {
    return value === 'scores' || value === 'reads'
      ? null
      : `week chart persisted as ${JSON.stringify(value)}`;
  }
  const jsonNamespaces = ['consistency', 'notifications:', 'rank.celebrated:'];
  if (jsonNamespaces.some(prefix => key.startsWith(prefix))) {
    if (value === '') return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === 'object'
        ? null
        : `${key} persisted non-object JSON`;
    } catch {
      return `${key} persisted invalid JSON ${JSON.stringify(value.slice(0, 40))}`;
    }
  }
  return null;
}

export function auditPersisted(
  before: PersistedSnapshot,
  after: PersistedSnapshot,
  options: { weekChartMayChange: boolean },
): PersistedAudit {
  const problems: string[] = [];
  if (after.integrity !== 'ok')
    problems.push(`integrity_check: ${after.integrity}`);
  if (after.localShots !== before.localShots) {
    problems.push('local_shot rows changed during a read-only screen');
  }
  for (const [key, value] of Object.entries(after.kv)) {
    const problem = kvValueValid(key, value);
    if (problem) problems.push(problem);
    if (key.startsWith('profile:') && before.kv[key] !== value) {
      problems.push(`profile ${key} rewritten`);
    }
  }
  if (
    !options.weekChartMayChange &&
    (before.kv[WEEK_CHART_KV_KEY] ?? null) !==
      (after.kv[WEEK_CHART_KV_KEY] ?? null)
  ) {
    problems.push('week chart preference changed without a user toggle');
  }
  return {
    ok: problems.length === 0,
    problems,
    kvKeysAfter: Object.keys(after.kv),
  };
}

// ---------------------------------------------------------------------------
// Rendered-tree audit: strings that betray garbage reaching the user
// ---------------------------------------------------------------------------

export const GARBAGE_TEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bNaN\b/,
  /Invalid Date/i,
  /\bundefined\b/,
  /\[object Object\]/,
  /^null$/,
  /\bnull\b/,
];

export function findGarbageText(texts: readonly string[]): string[] {
  return texts.filter(text =>
    GARBAGE_TEXT_PATTERNS.some(pattern => pattern.test(text)),
  );
}

// ---------------------------------------------------------------------------
// Result table
// ---------------------------------------------------------------------------

export type Outcome = 'HELD' | 'BROKEN';

export interface ScenarioResult {
  id: string;
  seed: number;
  faults: Fault[];
  session: CatalogEntry['session'];
  interaction: Interaction;
  fixtureShots: number;
  expectation: LoadExpectation;
  outcome: Outcome;
  /** Which invariants failed (empty when HELD). */
  violations: string[];
  /** Non-failing observations worth a reader's attention. */
  observations: string[];
  /** Fake-clock ms (from mount) at which the court or its error was visible. */
  settledAtMs: number | null;
  finalState: 'court' | 'error' | 'loading' | 'crashed' | 'other';
  retryControlVisible: boolean;
  recoveredAfterClear: boolean | null;
  persisted: PersistedAudit | null;
  sqliteCalls: number;
  fetchCalls: number;
  poisonCalls: number;
  consoleErrors: string[];
  textsSample: string[];
  durationMs: number;
  replay: string;
}
