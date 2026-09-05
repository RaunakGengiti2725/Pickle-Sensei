/**
 * Support for the NotificationSettingsScreen failure-injection stress
 * harness (`__tests__/stress/notificationSettingsScreen.failureInjection
 * .stress.test.tsx`).
 *
 * Everything here is deterministic and side-effect free except through the
 * `FaultController`, which the two native seams (the op-sqlite shim and the
 * notification module fake) consult on every call. The harness arms a fault
 * set on the controller, drives the real screen, and reads the call log,
 * the fake OS tray and the real SQLite file back to judge the invariants.
 */

// ---------------------------------------------------------------------------
// Seeded RNG (replay = same seed → same choices)
// ---------------------------------------------------------------------------

export interface Rng {
  next(): number;
  int(min: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
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
    int: (min, maxInclusive) =>
      min + Math.floor(next() * (maxInclusive - min + 1)),
    pick: items => {
      if (items.length === 0) throw new Error('pick from empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    chance: p => next() < p,
  };
}

export function hash32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

/** Every dependency the screen reaches, by operation. */
export type Channel =
  | 'sqlite.open'
  | 'sqlite.kvRead'
  | 'sqlite.kvWrite'
  | 'sqlite.history'
  | 'notify.settings'
  | 'notify.request'
  | 'notify.ids'
  | 'notify.cancel'
  | 'notify.create'
  | 'linking.openSettings'
  | 'clock'
  | 'nav'
  | 'owner';

export type FaultMode =
  | 'throw' // synchronous throw from the native call
  | 'reject' // returned promise rejects
  | 'never' // returned promise never settles
  | 'slow' // settles after `delayMs` of (fake) time
  | 'malformed' // settles with a payload of the wrong shape (`variant`)
  | 'partial' // succeeds for part of a sequence (`nth`)
  | 'flaky' // fails the first `nth` calls, then succeeds
  | 'variant'; // channel-specific behaviour (`variant`), e.g. a clock instant

export interface Fault {
  channel: Channel;
  mode: FaultMode;
  variant?: string;
  delayMs?: number;
  nth?: number;
}

export function faultId(fault: Fault): string {
  const parts: string[] = [fault.channel, fault.mode];
  if (fault.variant) parts.push(fault.variant);
  if (fault.delayMs !== undefined) parts.push(`${fault.delayMs}ms`);
  if (fault.nth !== undefined) parts.push(`n${fault.nth}`);
  return parts.join(':');
}

/** When a fault is armed relative to the screen's life. */
export type Phase = 'boot' | 'action';

export type StartState =
  | 'off-undetermined'
  | 'off-denied'
  | 'on-granted'
  | 'on-provisional'
  | 'on-denied'
  | 'on-unknown';

export type Action =
  | 'focusOnly'
  | 'turnOn'
  | 'toggleMaster'
  | 'togglePractice'
  | 'toggleStreak'
  | 'toggleWeekly'
  | 'toggleComeback'
  | 'preset'
  | 'stepEarlier'
  | 'stepLater'
  | 'rapidToggles'
  | 'openSettings'
  | 'checkAgain'
  | 'back'
  | 'backAndReenter';

export interface CatalogEntry {
  id: string;
  faults: Fault[];
  phase: Phase;
  starts: readonly StartState[];
  actions: readonly Action[];
}

const ENABLED_STARTS: readonly StartState[] = [
  'on-granted',
  'on-provisional',
  'on-denied',
];
const ALL_STARTS: readonly StartState[] = [
  'off-undetermined',
  'off-denied',
  'on-granted',
  'on-provisional',
  'on-denied',
  'on-unknown',
];
const WRITE_ACTIONS: readonly Action[] = [
  'toggleMaster',
  'togglePractice',
  'toggleStreak',
  'toggleWeekly',
  'toggleComeback',
  'preset',
  'stepEarlier',
  'stepLater',
  'rapidToggles',
];
const SCHEDULE_ACTIONS: readonly Action[] = [
  'toggleMaster',
  'togglePractice',
  'toggleStreak',
  'preset',
  'stepLater',
  'rapidToggles',
];

export const SLOW_DELAYS_MS = [1500, 8000, 30_000, 59_000] as const;

export const KV_MALFORMED_VARIANTS: Record<string, string> = {
  notJson: 'not json at all',
  arrayPayload: '[1,2,3]',
  nullLiteral: 'null',
  wrongTypes:
    '{"version":1,"enabled":"yes","practiceReminder":1,"practiceReminderMinutes":"17:30","streakDefense":null,"weeklyRecap":"true","comeback":0,"promptDismissed":"no"}',
  minutesOutOfRange:
    '{"version":1,"enabled":true,"practiceReminder":true,"practiceReminderMinutes":99999,"streakDefense":true,"weeklyRecap":true,"comeback":true,"promptDismissed":true}',
  minutesNegative:
    '{"version":1,"enabled":true,"practiceReminder":true,"practiceReminderMinutes":-30,"streakDefense":true,"weeklyRecap":true,"comeback":true,"promptDismissed":true}',
  minutesFractional:
    '{"version":1,"enabled":true,"practiceReminder":true,"practiceReminderMinutes":17.5,"streakDefense":true,"weeklyRecap":true,"comeback":true,"promptDismissed":true}',
  minutesBoundary1440:
    '{"version":1,"enabled":true,"practiceReminder":true,"practiceReminderMinutes":1440,"streakDefense":true,"weeklyRecap":true,"comeback":true,"promptDismissed":true}',
  futureVersion: '{"version":2,"enabled":true,"practiceReminderMinutes":480}',
  truncated: '{"version":1,"enabled":true,"practiceRemin',
  emptyObject: '{}',
  hugeBlob: `{"version":1,"enabled":true,"pad":"${'x'.repeat(200_000)}"}`,
};

export const NOTIFY_STATUS_VARIANTS: Record<string, unknown> = {
  emptyObject: {},
  undefinedStatus: { authorizationStatus: undefined },
  nullStatus: { authorizationStatus: null },
  stringStatus: { authorizationStatus: 'granted' },
  nanStatus: { authorizationStatus: NaN },
  status99: { authorizationStatus: 99 },
  statusMinus2: { authorizationStatus: -2 },
  nullSettings: null,
  undefinedSettings: undefined,
};

export const NOTIFY_IDS_VARIANTS: Record<string, unknown> = {
  nullIds: null,
  undefinedIds: undefined,
  objectIds: { ids: ['ps.reminder.practice'] },
  stringIds: 'ps.reminder.practice',
  mixedNull: [null, 'ps.reminder.practice'],
  mixedNumber: [42, 'ps.reminder.streak'],
  mixedUndefined: ['ps.reminder.practice', undefined],
  foreignOnly: ['com.other.app.reminder', 'ps'],
};

export type ClockVariant =
  | 'epoch1970'
  | 'y2038'
  | 'y2099'
  | 'lateNight'
  | 'dstSpring'
  | 'dstFall'
  | 'nanNow';

export const CLOCK_VARIANTS: readonly ClockVariant[] = [
  'epoch1970',
  'y2038',
  'y2099',
  'lateNight',
  'dstSpring',
  'dstFall',
  'nanNow',
];

/** The instant a clock variant boots the screen at (local wall clock for
 * `lateNight`, so the daily reminder math crosses midnight everywhere). */
export function clockInstant(variant: ClockVariant, baseIso: string): Date {
  switch (variant) {
    case 'epoch1970':
      return new Date('1970-01-02T12:00:00.000Z');
    case 'y2038':
      return new Date('2038-01-19T03:13:00.000Z');
    case 'y2099':
      return new Date('2099-12-31T23:58:30.000Z');
    case 'lateNight': {
      const d = new Date(baseIso);
      d.setHours(23, 59, 30, 0);
      return d;
    }
    case 'dstSpring':
      return new Date('2026-03-08T09:59:00.000Z');
    case 'dstFall':
      return new Date('2026-11-01T08:59:00.000Z');
    case 'nanNow':
      return new Date(baseIso);
  }
}

export type NavVariant = 'backMidFlight' | 'doubleBack' | 'reenterUnderFault';
export type OwnerVariant = 'switchMidFlight' | 'signOutMidFlight';

export function buildCatalog(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const add = (
    faults: Fault[],
    phase: Phase,
    starts: readonly StartState[],
    actions: readonly Action[],
  ) => {
    const base = `${faults.map(faultId).join('+')}@${phase}`;
    const dupes = entries.filter(
      e => e.id === base || e.id.startsWith(`${base}#`),
    );
    entries.push({
      id: dupes.length ? `${base}#${dupes.length + 1}` : base,
      faults,
      phase,
      starts,
      actions,
    });
  };

  // SQLite: open + kv read (boot), kv write (action), history (both).
  add([{ channel: 'sqlite.open', mode: 'throw' }], 'boot', ALL_STARTS, [
    'focusOnly',
    'toggleMaster',
    'turnOn',
  ]);
  for (const mode of ['throw', 'reject', 'never'] as const) {
    add([{ channel: 'sqlite.kvRead', mode }], 'boot', ENABLED_STARTS, [
      'focusOnly',
      'togglePractice',
      'stepLater',
    ]);
  }
  for (const delayMs of SLOW_DELAYS_MS) {
    add(
      [{ channel: 'sqlite.kvRead', mode: 'slow', delayMs }],
      'boot',
      ENABLED_STARTS,
      // The pre-hydration screen shows the "Turn on" card, so a user taps it.
      ['focusOnly', 'togglePractice', 'turnOn'],
    );
  }
  for (const variant of Object.keys(KV_MALFORMED_VARIANTS)) {
    add(
      [{ channel: 'sqlite.kvRead', mode: 'malformed', variant }],
      'boot',
      ['on-granted'],
      ['focusOnly', 'togglePractice', 'stepEarlier'],
    );
  }
  add(
    [{ channel: 'sqlite.kvRead', mode: 'partial', variant: 'noValueColumn' }],
    'boot',
    ['on-granted'],
    ['focusOnly', 'toggleWeekly'],
  );
  add(
    [{ channel: 'sqlite.kvRead', mode: 'partial', variant: 'numericValue' }],
    'boot',
    ['on-granted'],
    ['focusOnly', 'toggleComeback'],
  );
  for (const mode of ['throw', 'reject', 'never'] as const) {
    add([{ channel: 'sqlite.kvWrite', mode }], 'action', ENABLED_STARTS, [
      ...WRITE_ACTIONS,
    ]);
    add(
      [{ channel: 'sqlite.kvWrite', mode }],
      'action',
      ['off-undetermined'],
      ['turnOn'],
    );
  }
  for (const delayMs of SLOW_DELAYS_MS) {
    add(
      [{ channel: 'sqlite.kvWrite', mode: 'slow', delayMs }],
      'action',
      ENABLED_STARTS,
      WRITE_ACTIONS,
    );
  }
  for (const nth of [1, 2, 3]) {
    add(
      [{ channel: 'sqlite.kvWrite', mode: 'flaky', nth }],
      'action',
      ENABLED_STARTS,
      WRITE_ACTIONS,
    );
  }
  for (const mode of ['throw', 'reject', 'never'] as const) {
    add(
      [{ channel: 'sqlite.history', mode }],
      'boot',
      ['on-granted'],
      ['focusOnly', 'toggleStreak'],
    );
    add(
      [{ channel: 'sqlite.history', mode }],
      'action',
      ['on-granted'],
      ['toggleStreak', 'preset', 'rapidToggles'],
    );
  }
  add(
    [{ channel: 'sqlite.history', mode: 'slow', delayMs: 30_000 }],
    'action',
    ['on-granted'],
    ['togglePractice', 'rapidToggles'],
  );
  add(
    [{ channel: 'sqlite.history', mode: 'malformed', variant: 'garbageRows' }],
    'boot',
    ['on-granted'],
    ['focusOnly', 'toggleStreak'],
  );

  // Notification module: permission read (focus/hydrate + Check again).
  for (const mode of ['throw', 'reject', 'never'] as const) {
    add([{ channel: 'notify.settings', mode }], 'boot', ALL_STARTS, [
      'focusOnly',
      'toggleMaster',
      'turnOn',
      'backAndReenter',
    ]);
    add(
      [{ channel: 'notify.settings', mode }],
      'action',
      ['on-unknown'],
      ['checkAgain'],
    );
  }
  for (const delayMs of SLOW_DELAYS_MS) {
    add(
      [{ channel: 'notify.settings', mode: 'slow', delayMs }],
      'boot',
      ['on-granted', 'off-undetermined'],
      ['focusOnly', 'togglePractice', 'turnOn'],
    );
  }
  for (const variant of Object.keys(NOTIFY_STATUS_VARIANTS)) {
    add(
      [{ channel: 'notify.settings', mode: 'malformed', variant }],
      'boot',
      ['on-denied', 'off-denied'],
      ['focusOnly', 'togglePractice'],
    );
  }

  // Permission request (Turn on reminders).
  for (const mode of ['throw', 'reject', 'never'] as const) {
    add(
      [{ channel: 'notify.request', mode }],
      'action',
      ['off-undetermined'],
      ['turnOn'],
    );
  }
  for (const delayMs of SLOW_DELAYS_MS) {
    add(
      [{ channel: 'notify.request', mode: 'slow', delayMs }],
      'action',
      ['off-undetermined'],
      ['turnOn'],
    );
  }
  for (const variant of Object.keys(NOTIFY_STATUS_VARIANTS)) {
    add(
      [{ channel: 'notify.request', mode: 'malformed', variant }],
      'action',
      ['off-undetermined'],
      ['turnOn'],
    );
  }
  for (const variant of ['denied', 'notDetermined', 'provisional']) {
    add(
      [{ channel: 'notify.request', mode: 'variant', variant }],
      'action',
      ['off-undetermined'],
      ['turnOn'],
    );
  }

  // Tray reads / cancels / creates (boot sync and action sync).
  for (const mode of ['throw', 'reject', 'never'] as const) {
    add([{ channel: 'notify.ids', mode }], 'boot', ENABLED_STARTS, [
      'focusOnly',
      'toggleMaster',
    ]);
    add(
      [{ channel: 'notify.ids', mode }],
      'action',
      ['on-granted'],
      [...SCHEDULE_ACTIONS],
    );
    add(
      [{ channel: 'notify.cancel', mode }],
      'action',
      ['on-granted'],
      [...SCHEDULE_ACTIONS],
    );
    add(
      [{ channel: 'notify.create', mode }],
      'boot',
      ['on-granted'],
      ['focusOnly', 'togglePractice'],
    );
    add(
      [{ channel: 'notify.create', mode }],
      'action',
      ['on-granted'],
      [...SCHEDULE_ACTIONS],
    );
    add(
      [{ channel: 'notify.create', mode }],
      'action',
      ['off-undetermined'],
      ['turnOn'],
    );
  }
  for (const delayMs of SLOW_DELAYS_MS) {
    add(
      [{ channel: 'notify.ids', mode: 'slow', delayMs }],
      'action',
      ['on-granted'],
      SCHEDULE_ACTIONS,
    );
    add(
      [{ channel: 'notify.create', mode: 'slow', delayMs }],
      'action',
      ['on-granted'],
      SCHEDULE_ACTIONS,
    );
  }
  for (const variant of Object.keys(NOTIFY_IDS_VARIANTS)) {
    add(
      [{ channel: 'notify.ids', mode: 'malformed', variant }],
      'action',
      ['on-granted'],
      SCHEDULE_ACTIONS,
    );
  }
  add(
    [{ channel: 'notify.cancel', mode: 'partial', nth: 1 }],
    'action',
    ['on-granted'],
    SCHEDULE_ACTIONS,
  );
  for (const nth of [1, 2, 3]) {
    add(
      [{ channel: 'notify.create', mode: 'partial', nth }],
      'action',
      ['on-granted'],
      SCHEDULE_ACTIONS,
    );
  }
  add(
    [{ channel: 'notify.create', mode: 'flaky', nth: 1 }],
    'action',
    ['on-granted'],
    SCHEDULE_ACTIONS,
  );

  // System settings deep link.
  for (const mode of ['throw', 'reject', 'never'] as const) {
    add(
      [{ channel: 'linking.openSettings', mode }],
      'action',
      ['off-denied', 'on-denied'],
      ['openSettings'],
    );
  }
  add(
    [{ channel: 'linking.openSettings', mode: 'slow', delayMs: 8000 }],
    'action',
    ['off-denied', 'on-denied'],
    ['openSettings'],
  );
  // Settings link failing right after a failed permission request.
  add(
    [
      { channel: 'notify.request', mode: 'reject' },
      { channel: 'linking.openSettings', mode: 'reject' },
    ],
    'action',
    ['off-undetermined'],
    ['turnOn'],
  );

  // Clock.
  for (const variant of CLOCK_VARIANTS) {
    add(
      [{ channel: 'clock', mode: 'variant', variant }],
      'boot',
      ['on-granted'],
      ['focusOnly', 'togglePractice', 'stepLater', 'preset'],
    );
  }

  // Navigation and account-owner races around an in-flight write.
  for (const variant of ['backMidFlight', 'doubleBack'] as const) {
    add(
      [
        { channel: 'sqlite.kvWrite', mode: 'slow', delayMs: 8000 },
        { channel: 'nav', mode: 'variant', variant },
      ],
      'action',
      ['on-granted'],
      ['togglePractice', 'stepLater'],
    );
  }
  add(
    [
      { channel: 'notify.settings', mode: 'reject' },
      { channel: 'nav', mode: 'variant', variant: 'reenterUnderFault' },
    ],
    'action',
    ['on-granted', 'off-undetermined'],
    ['backAndReenter'],
  );
  for (const variant of ['switchMidFlight', 'signOutMidFlight'] as const) {
    add(
      [
        { channel: 'sqlite.kvWrite', mode: 'slow', delayMs: 8000 },
        { channel: 'owner', mode: 'variant', variant },
      ],
      'action',
      ['on-granted'],
      ['togglePractice', 'toggleMaster'],
    );
  }

  return entries;
}

/** A random 2-fault combination for the seeded extra iterations. */
export function randomCatalogEntry(rng: Rng, iteration: number): CatalogEntry {
  const pool = buildCatalog().filter(
    e => e.faults.length === 1 && e.faults[0]?.channel !== 'clock',
  );
  const a = rng.pick(pool);
  let b = rng.pick(pool);
  let guard = 0;
  while (b.faults[0]?.channel === a.faults[0]?.channel && guard++ < 20) {
    b = rng.pick(pool);
  }
  const faults = [...a.faults, ...b.faults];
  const starts = a.starts.filter(s => b.starts.includes(s));
  const actions = a.actions.filter(x => b.actions.includes(x));
  return {
    id: `random#${iteration}:${faults.map(faultId).join('+')}`,
    faults,
    phase: a.phase === 'boot' || b.phase === 'boot' ? 'boot' : 'action',
    starts: starts.length ? starts : a.starts,
    actions: actions.length ? actions : a.actions,
  };
}

// ---------------------------------------------------------------------------
// Fault controller shared with the native seams
// ---------------------------------------------------------------------------

export interface CallRecord {
  channel: Channel | 'sqlite.other';
  detail: string;
  outcome: 'ok' | 'threw' | 'rejected' | 'hung' | 'delayed' | 'malformed';
}

export interface NodeSqliteStatement {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
}
export interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  exec(sql: string): void;
  close(): void;
}

export interface FaultController {
  faults: Fault[];
  calls: CallRecord[];
  hits: Map<string, number>;
  real: NodeSqliteDatabase | null;
  /** What the OS would report for `getNotificationSettings`. */
  osStatus: number;
  /** What the OS would answer the permission prompt with. */
  osStatusAfterRequest: number;
  /** Fake notification tray: id → trigger the module was given. */
  tray: Map<string, { timestamp: unknown; repeatFrequency: unknown }>;
  /** Dependencies this screen must never reach (fetch, Keychain, RevenueCat):
   * every access is recorded here and throws. */
  outOfScope: string[];
  /** Injected exception messages (never user copy). */
  arm(faults: readonly Fault[]): void;
  clear(): void;
  faultFor(channel: Channel): Fault | undefined;
  /** Counts a hit on the fault and reports whether it applies this call. */
  applies(fault: Fault): boolean;
}

export function createFaultController(): FaultController {
  const ctl: FaultController = {
    faults: [],
    calls: [],
    hits: new Map(),
    real: null,
    osStatus: -1,
    osStatusAfterRequest: 1,
    tray: new Map(),
    outOfScope: [],
    arm(faults) {
      ctl.faults = [...faults];
    },
    clear() {
      ctl.faults = [];
    },
    faultFor(channel) {
      return ctl.faults.find(f => f.channel === channel);
    },
    applies(fault) {
      const key = faultId(fault);
      const n = (ctl.hits.get(key) ?? 0) + 1;
      ctl.hits.set(key, n);
      if (fault.mode === 'flaky') return n <= (fault.nth ?? 1);
      if (fault.mode === 'partial') return n === (fault.nth ?? 1);
      return true;
    },
  };
  return ctl;
}

/** One controller per Jest module registry: the hoisted `jest.mock`
 * factories and the test body must see the same instance. */
export const sharedController: FaultController = createFaultController();

/** A module stand-in whose every property access is recorded and whose
 * every call throws — proves the unit never reaches the dependency. */
export function createOutOfScopePoison(
  ctl: FaultController,
  name: string,
): unknown {
  const poison = (path: string): unknown =>
    new Proxy(function poisoned() {} as unknown as object, {
      get(_target, prop) {
        if (prop === '__esModule') return true;
        if (prop === 'then') return undefined;
        const at = `${path}.${String(prop)}`;
        ctl.outOfScope.push(at);
        return poison(at);
      },
      apply() {
        ctl.outOfScope.push(`${path}()`);
        throw new Error(`out-of-scope dependency reached: ${path}()`);
      },
      construct() {
        ctl.outOfScope.push(`new ${path}`);
        throw new Error(`out-of-scope dependency reached: new ${path}`);
      },
    });
  return poison(name);
}

export function injectedError(fault: Fault): Error {
  return new Error(`injected ${faultId(fault)}`);
}

/**
 * Applies the armed fault (if any) for `channel` around `run`, the real
 * behaviour. Returns the value the native seam should hand back — a value,
 * a rejected promise, a hung promise, a delayed promise — or throws.
 */
export function applyAsyncFault<T>(
  ctl: FaultController,
  channel: Channel,
  detail: string,
  run: () => T,
  malformed?: (variant: string | undefined) => unknown,
): Promise<unknown> {
  const fault = ctl.faultFor(channel);
  const record = (outcome: CallRecord['outcome']) =>
    ctl.calls.push({ channel, detail, outcome });
  if (!fault || !ctl.applies(fault)) {
    record('ok');
    return Promise.resolve(run());
  }
  switch (fault.mode) {
    case 'throw':
      record('threw');
      throw injectedError(fault);
    case 'reject':
    case 'flaky':
    case 'partial':
      record('rejected');
      return Promise.reject(injectedError(fault));
    case 'never':
      record('hung');
      return new Promise(() => {});
    case 'slow': {
      record('delayed');
      const value = run();
      return new Promise(resolve =>
        setTimeout(() => resolve(value), fault.delayMs ?? 1000),
      );
    }
    case 'malformed':
      record('malformed');
      if (!malformed) return Promise.resolve(run());
      return Promise.resolve(malformed(fault.variant));
    case 'variant':
      record('ok');
      return Promise.resolve(run());
  }
}

// ---------------------------------------------------------------------------
// op-sqlite shim over a real node:sqlite database
// ---------------------------------------------------------------------------

export type SqlChannel = 'sqlite.kvRead' | 'sqlite.kvWrite' | 'sqlite.history';

export function classifySql(sql: string): SqlChannel | 'sqlite.other' {
  const text = sql.replace(/\s+/g, ' ').trim();
  if (text.startsWith('SELECT value FROM kv')) return 'sqlite.kvRead';
  if (text.startsWith('INSERT OR REPLACE INTO kv')) return 'sqlite.kvWrite';
  if (/FROM local_shot/i.test(text)) return 'sqlite.history';
  return 'sqlite.other';
}

interface OpSqliteLike {
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  executeSync(sql: string, params?: unknown[]): { rows: unknown[] };
  close(): void;
}

export function createOpSqliteShim(ctl: FaultController): {
  open(options: { name: string }): OpSqliteLike;
} {
  return {
    open() {
      const openFault = ctl.faultFor('sqlite.open');
      if (openFault && ctl.applies(openFault)) {
        ctl.calls.push({
          channel: 'sqlite.open',
          detail: 'open',
          outcome: 'threw',
        });
        throw injectedError(openFault);
      }
      const real = ctl.real;
      if (!real) throw new Error('harness: no real database installed');
      const run = (sql: string, params: unknown[]) => {
        const rows = real.prepare(sql).all(...params) as Record<
          string,
          unknown
        >[];
        return { rows };
      };
      return {
        executeSync: (sql, params = []) => run(sql, params),
        execute: (sql, params = []) => {
          const channel = classifySql(sql);
          if (channel === 'sqlite.other') {
            ctl.calls.push({
              channel,
              detail: sql.slice(0, 40),
              outcome: 'ok',
            });
            return Promise.resolve(run(sql, params));
          }
          return applyAsyncFault(
            ctl,
            channel,
            `${sql.slice(0, 32)} ${JSON.stringify(params).slice(0, 60)}`,
            () => run(sql, params),
            variant => {
              if (channel === 'sqlite.kvRead') {
                if (variant === 'noValueColumn') return { rows: [{}] };
                if (variant === 'numericValue')
                  return { rows: [{ value: 12345 }] };
                return { rows: [{ value: null }] };
              }
              if (channel === 'sqlite.history') {
                return {
                  rows: [
                    {
                      id: null,
                      session_id: 7,
                      shot_type: undefined,
                      captured_at: 'not a date',
                      overall_score: 'NaN',
                      result_kind: 42,
                    },
                    { captured_at: null },
                  ],
                };
              }
              return run(sql, params);
            },
          ) as Promise<{ rows: Record<string, unknown>[] }>;
        },
        close: () => {
          // The harness owns the node:sqlite handle; nothing to do here.
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Notification native module fake (react-native-notify-kit surface)
// ---------------------------------------------------------------------------

export const FOREIGN_TRAY_ID = 'com.other.app.reminder';
const MIN_PLAUSIBLE_EPOCH_MS = 1e12;

/** Mirrors `validateTimestampTrigger` in react-native-notify-kit's
 * `dist/validators/validateTrigger.js` so a garbage timestamp fails the way
 * the real JS API fails before it reaches native. */
export function validateTimestampTrigger(trigger: unknown): void {
  if (!trigger || typeof trigger !== 'object') {
    throw new Error("'trigger' expected an object value.");
  }
  const ts = (trigger as { timestamp?: unknown }).timestamp;
  if (typeof ts !== 'number') {
    throw new Error("'trigger.timestamp' expected a number value.");
  }
  if (ts < MIN_PLAUSIBLE_EPOCH_MS) {
    throw new Error(
      `'trigger.timestamp' (${ts}) is too small to be a valid epoch millisecond value.`,
    );
  }
  if (ts <= Date.now()) {
    throw new Error("'trigger.timestamp' date must be in the future.");
  }
}

export function createNotifyKitFake(ctl: FaultController): {
  default: Record<string, (...args: unknown[]) => unknown>;
  AndroidImportance: Record<string, number>;
  RepeatFrequency: Record<string, number>;
  TriggerType: Record<string, number>;
  EventType: Record<string, number>;
} {
  const statusPayload = (status: number, variant: string | undefined) =>
    variant && variant in NOTIFY_STATUS_VARIANTS
      ? NOTIFY_STATUS_VARIANTS[variant]
      : { authorizationStatus: status };
  return {
    default: {
      getNotificationSettings: () =>
        applyAsyncFault(
          ctl,
          'notify.settings',
          'getNotificationSettings',
          () => ({ authorizationStatus: ctl.osStatus }),
          variant => statusPayload(ctl.osStatus, variant),
        ),
      requestPermission: () => {
        const fault = ctl.faultFor('notify.request');
        const answer = () => {
          const status =
            fault?.mode === 'variant'
              ? fault.variant === 'denied'
                ? 0
                : fault.variant === 'notDetermined'
                  ? -1
                  : fault.variant === 'provisional'
                    ? 2
                    : ctl.osStatusAfterRequest
              : ctl.osStatusAfterRequest;
          // A real prompt answer changes what the OS reports afterwards.
          if (status === 0 || status === 1 || status === 2)
            ctl.osStatus = status;
          return { authorizationStatus: status };
        };
        return applyAsyncFault(
          ctl,
          'notify.request',
          'requestPermission',
          answer,
          variant => statusPayload(ctl.osStatusAfterRequest, variant),
        );
      },
      getTriggerNotificationIds: () =>
        applyAsyncFault(
          ctl,
          'notify.ids',
          'getTriggerNotificationIds',
          () => [...ctl.tray.keys()],
          variant =>
            variant && variant in NOTIFY_IDS_VARIANTS
              ? NOTIFY_IDS_VARIANTS[variant]
              : [...ctl.tray.keys()],
        ),
      cancelTriggerNotification: (...args: unknown[]) => {
        const id = String(args[0]);
        return applyAsyncFault(ctl, 'notify.cancel', `cancel ${id}`, () => {
          ctl.tray.delete(id);
          return undefined;
        });
      },
      createTriggerNotification: (...args: unknown[]) => {
        const notification = args[0] as { id?: unknown };
        const trigger = args[1] as {
          timestamp?: unknown;
          repeatFrequency?: unknown;
        };
        const id = String(notification?.id ?? '');
        // Validation runs before any fault, exactly like the real JS API.
        try {
          validateTimestampTrigger(trigger);
        } catch (error) {
          ctl.calls.push({
            channel: 'notify.create',
            detail: `create ${id} invalid: ${String((error as Error).message)}`,
            outcome: 'rejected',
          });
          return Promise.reject(error);
        }
        return applyAsyncFault(ctl, 'notify.create', `create ${id}`, () => {
          ctl.tray.set(id, {
            timestamp: trigger.timestamp,
            repeatFrequency: trigger.repeatFrequency ?? -1,
          });
          return id;
        });
      },
      createChannel: () => Promise.resolve('reminders'),
      openNotificationSettings: () => Promise.resolve(undefined),
      getInitialNotification: () => Promise.resolve(null),
      onForegroundEvent: () => () => {},
      onBackgroundEvent: () => {},
    },
    AndroidImportance: { DEFAULT: 3, HIGH: 4 },
    RepeatFrequency: { NONE: -1, HOURLY: 0, DAILY: 1, WEEKLY: 2 },
    TriggerType: { TIMESTAMP: 0, INTERVAL: 1 },
    EventType: { DISMISSED: 0, PRESS: 1, DELIVERED: 3 },
  };
}

// ---------------------------------------------------------------------------
// Persisted-state audit
// ---------------------------------------------------------------------------

export interface KvRow {
  key: string;
  value: unknown;
}

export function readKv(real: NodeSqliteDatabase): KvRow[] {
  return real
    .prepare('SELECT key, value FROM kv ORDER BY key')
    .all()
    .map(row => {
      const r = row as Record<string, unknown>;
      return { key: String(r['key']), value: r['value'] };
    });
}

export function integrityCheck(real: NodeSqliteDatabase): string {
  const row = real.prepare('PRAGMA integrity_check').get() as
    Record<string, unknown> | undefined;
  return String(row?.['integrity_check'] ?? 'missing');
}

/** Strings a user must never see rendered as data. */
const GARBAGE = ['NaN', 'undefined', 'null', 'Invalid Date', '[object Object]'];

export function findGarbageText(texts: readonly string[]): string[] {
  const isWordChar = (ch: string | undefined) =>
    ch !== undefined && /[A-Za-z]/.test(ch);
  return texts.filter(text =>
    GARBAGE.some(g => {
      let from = 0;
      for (;;) {
        const at = text.indexOf(g, from);
        if (at < 0) return false;
        if (!isWordChar(text[at - 1]) && !isWordChar(text[at + g.length]))
          return true;
        from = at + 1;
      }
    }),
  );
}

export interface ScenarioResult {
  id: string;
  seed: number;
  faults: string[];
  phase: Phase;
  start: StartState;
  action: Action;
  detail: Record<string, unknown>;
  outcome: 'HELD' | 'BROKEN';
  violations: string[];
  observations: string[];
  durationMs: number;
  replay: string;
}
