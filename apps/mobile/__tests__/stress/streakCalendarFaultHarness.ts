/**
 * Seeded failure-injection harness for StreakCalendarScreen.
 *
 * Every dependency the screen can reach at runtime is modelled here so a
 * single seed fully determines: the account, the persisted SQLite fixture
 * (shots + consistency ledger), the device clock/time zone, and the fault
 * that is injected on the load path. Nothing here touches production code;
 * `installFakeDb` is wired in by the stress suite through `jest.mock`.
 */
import type { LocalDb } from '../../src/data/db';
import type { TrainingActivityInput } from '../../src/consistency/engine';

// ---------------------------------------------------------------- RNG ----

/** mulberry32 — small, fast, fully replayable from a 32-bit seed. */
export function makeRng(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min: number, max: number): number {
      return min + Math.floor(next() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)]!;
    },
    chance(p: number): boolean {
      return next() < p;
    },
    uuid(): string {
      const hex = '0123456789abcdef';
      let out = '';
      for (let i = 0; i < 32; i++) {
        if (i === 12) out += '4';
        else if (i === 16) out += hex[8 + Math.floor(next() * 4)];
        else out += hex[Math.floor(next() * 16)];
        if (i === 7 || i === 11 || i === 15 || i === 19) out += '-';
      }
      return out;
    },
  };
}
export type Rng = ReturnType<typeof makeRng>;

// ------------------------------------------------------------ fixtures ----

export const TIME_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Asia/Kolkata',
  'Asia/Tokyo',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
  'Australia/Lord_Howe',
] as const;

export const SHOT_TYPES = ['dink', 'drive', 'serve', 'volley', 'third_shot'];

export interface FixtureShot {
  id: string;
  sessionId: string | null;
  shotType: string;
  capturedAt: string;
  overallScore: number | null;
  resultKind: string;
}

export interface FixtureDrill {
  id: string;
  slug: string;
  title: string;
  completedAtIso: string;
}

export interface Fixture {
  owner: string;
  nowIso: string;
  timeZone: string;
  shots: FixtureShot[];
  drills: FixtureDrill[];
  celebrated: Record<string, string>;
  daySecuredShownDay: string | null;
  ledgerRaw: string;
}

const DAY_MS = 86_400_000;

export function buildFixture(rng: Rng): Fixture {
  const owner = rng.uuid();
  // A deterministic "now" anywhere in a two-year window, any time of day.
  const base = Date.UTC(2025, 0, 1) + rng.int(0, 730) * DAY_MS;
  const nowMs = base + rng.int(0, DAY_MS - 1);
  const timeZone = rng.pick(TIME_ZONES);

  const shots: FixtureShot[] = [];
  const shape = rng.pick(['none', 'sparse', 'streak', 'dense'] as const);
  const dayCount =
    shape === 'none'
      ? 0
      : shape === 'sparse'
        ? rng.int(1, 6)
        : shape === 'streak'
          ? rng.int(3, 45)
          : rng.int(20, 120);
  for (let d = 0; d < dayCount; d++) {
    // 'streak' trains every day back from today; others scatter.
    const daysAgo = shape === 'streak' ? d : rng.int(0, 120);
    const perDay = shape === 'dense' ? rng.int(1, 4) : 1;
    for (let k = 0; k < perDay; k++) {
      const at = nowMs - daysAgo * DAY_MS - rng.int(0, DAY_MS - 1);
      const scored = rng.chance(0.8);
      shots.push({
        id: `shot-${shots.length}-${rng.int(1000, 9999)}`,
        sessionId: rng.chance(0.3) ? `session-${rng.int(1, 50)}` : null,
        shotType: rng.pick(SHOT_TYPES),
        capturedAt: new Date(at).toISOString(),
        overallScore: scored ? Math.round(rng.next() * 100) / 10 : null,
        resultKind: scored ? 'scored' : 'low_confidence',
      });
    }
  }

  const drills: FixtureDrill[] = [];
  const drillCount = rng.chance(0.5) ? rng.int(1, 12) : 0;
  for (let i = 0; i < drillCount; i++) {
    drills.push({
      id: `drill-${i}-${rng.int(1000, 9999)}`,
      slug: `drill-slug-${rng.int(1, 30)}`,
      title: rng.chance(0.8) ? `Drill ${rng.int(1, 30)}` : '',
      completedAtIso: new Date(
        nowMs - rng.int(0, 90) * DAY_MS - rng.int(0, DAY_MS - 1),
      ).toISOString(),
    });
  }

  // Sometimes pre-celebrate a few milestone ids so the write path is or is
  // not exercised depending on the seed.
  const celebrated: Record<string, string> = {};
  if (rng.chance(0.4)) {
    for (const id of ['streak.1', 'streak.3', 'streak.7']) {
      if (rng.chance(0.5)) celebrated[id] = '2024-12-31';
    }
  }
  const daySecuredShownDay = rng.chance(0.3) ? '2024-12-30' : null;
  const ledgerRaw = JSON.stringify({
    version: 1,
    drills,
    celebrated,
    daySecuredShownDay,
  });
  return {
    owner,
    nowIso: new Date(nowMs).toISOString(),
    timeZone,
    shots,
    drills,
    celebrated,
    daySecuredShownDay,
    ledgerRaw,
  };
}

/**
 * Guarantee the ledger write path runs on the first load: at least one
 * trained day and nothing celebrated yet, so `refresh()` must persist the
 * first milestone. Used for kvWrite faults so every seed reaches the fault.
 */
export function withWritePath(fixture: Fixture): Fixture {
  const shots: FixtureShot[] =
    fixture.shots.length > 0
      ? fixture.shots
      : [
          {
            id: 'shot-write-path',
            sessionId: null,
            shotType: 'dink',
            capturedAt: fixture.nowIso,
            overallScore: 7.5,
            resultKind: 'scored' as const,
          },
        ];
  const celebrated: Record<string, string> = {};
  return {
    ...fixture,
    shots,
    celebrated,
    ledgerRaw: JSON.stringify({
      version: 1,
      drills: fixture.drills,
      celebrated,
      daySecuredShownDay: fixture.daySecuredShownDay,
    }),
  };
}

export function fixtureActivities(fixture: Fixture): TrainingActivityInput[] {
  const activities: TrainingActivityInput[] = fixture.shots.map(shot => ({
    kind: shot.sessionId ? 'session_stroke' : 'stroke',
    atIso: shot.capturedAt,
    shotType: shot.shotType,
    overallScore: shot.overallScore,
    resultKind: shot.resultKind,
  }));
  for (const drill of fixture.drills) {
    if (!drill.id || !drill.completedAtIso) continue;
    activities.push({
      kind: 'drill',
      atIso: drill.completedAtIso,
      label: drill.title || drill.slug,
    });
  }
  return activities;
}

// -------------------------------------------------------------- faults ----

export const FAULT_TARGETS = [
  'sqlite.getDb',
  'sqlite.shots',
  'sqlite.kvRead',
  'sqlite.kvWrite',
  'clock.timeZone',
  'clock.systemTime',
  'navigation',
  'account',
  'fetch',
  'native.unrelated',
] as const;
export type FaultTarget = (typeof FAULT_TARGETS)[number];

export const FAULT_KINDS = [
  'throw',
  'reject',
  'slow',
  'timeout',
  'never',
  'malformed',
  'partial',
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

/**
 * Which refreshes the fault is armed for: the very first load, every load
 * until the harness disarms it, or only the second load (a healthy first
 * load followed by a failing re-focus refresh).
 */
export type FaultPhase = 'first' | 'always' | 'second';

export interface Fault {
  target: FaultTarget;
  kind: FaultKind;
  phase: FaultPhase;
  /** Kind-specific detail (malformed variant, tz string, delay ms, …). */
  detail: string;
}

const DB_KINDS: readonly FaultKind[] = [
  'throw',
  'reject',
  'slow',
  'timeout',
  'never',
  'malformed',
  'partial',
];

export const MALFORMED_SHOT_VARIANTS = [
  'null-columns',
  'wrong-types',
  'garbage-dates',
  'nan-scores',
  'object-values',
  'huge',
] as const;

export const MALFORMED_KV_VARIANTS = [
  'truncated-json',
  'array',
  'null-literal',
  'number',
  'wrong-field-types',
  'drills-missing-ids',
  'celebrated-non-string',
  'binary-garbage',
  'huge-ledger',
  'future-version',
] as const;

export const BAD_TIME_ZONES = ['', 'Mars/Olympus', 'GMT+99', 'Not/AZone'];

export const ODD_SYSTEM_TIMES = [
  '1970-01-01T00:00:00.000Z',
  '2038-01-19T03:14:07.000Z',
  '2099-12-31T23:59:59.999Z',
  '2000-02-29T12:00:00.000Z',
  '2024-12-31T23:59:59.999Z',
];

export function faultForTarget(rng: Rng, target: FaultTarget): Fault {
  const roll = rng.next();
  const phase: FaultPhase =
    roll < 0.3 ? 'always' : roll < 0.45 ? 'second' : 'first';
  switch (target) {
    case 'sqlite.getDb':
      return { target, kind: 'throw', phase, detail: 'getDb throws' };
    case 'sqlite.shots': {
      const kind = rng.pick(DB_KINDS);
      return {
        target,
        kind,
        phase,
        detail:
          kind === 'malformed'
            ? rng.pick(MALFORMED_SHOT_VARIANTS)
            : kind === 'partial'
              ? 'rows-missing-columns'
              : kind === 'slow'
                ? `${rng.int(1, 8)}s`
                : kind === 'timeout'
                  ? `${rng.int(20, 55)}s`
                  : kind,
      };
    }
    case 'sqlite.kvRead': {
      const kind = rng.pick(DB_KINDS);
      return {
        target,
        kind,
        phase,
        detail:
          kind === 'malformed'
            ? rng.pick(MALFORMED_KV_VARIANTS)
            : kind === 'partial'
              ? 'ledger-missing-fields'
              : kind === 'slow'
                ? `${rng.int(1, 8)}s`
                : kind === 'timeout'
                  ? `${rng.int(20, 55)}s`
                  : kind,
      };
    }
    case 'sqlite.kvWrite': {
      const kind = rng.pick<FaultKind>([
        'throw',
        'reject',
        'slow',
        'timeout',
        'never',
      ]);
      return {
        target,
        kind,
        phase,
        detail:
          kind === 'slow'
            ? `${rng.int(1, 8)}s`
            : kind === 'timeout'
              ? `${rng.int(20, 55)}s`
              : kind,
      };
    }
    case 'clock.timeZone': {
      const kind = rng.pick(['throw', 'malformed'] as const);
      return {
        target,
        kind,
        phase: 'always',
        detail:
          kind === 'throw'
            ? 'resolvedOptions throws'
            : rng.pick(BAD_TIME_ZONES),
      };
    }
    case 'clock.systemTime':
      return {
        target,
        kind: 'malformed',
        phase: 'always',
        detail: rng.pick(ODD_SYSTEM_TIMES),
      };
    case 'navigation':
      return {
        target,
        kind: rng.pick(['partial', 'slow'] as const),
        phase: 'first',
        detail: rng.pick([
          'back-while-loading',
          'rapid-focus-toggle',
          'double-retry-press',
        ]),
      };
    case 'account':
      return {
        target,
        kind: 'partial',
        phase: 'first',
        detail: rng.pick([
          'sign-out-while-loading',
          'switch-owner-while-loading',
        ]),
      };
    case 'fetch':
      return {
        target,
        kind: rng.pick(['throw', 'reject', 'never'] as const),
        phase: 'always',
        detail: 'global.fetch poisoned',
      };
    case 'native.unrelated':
      return {
        target,
        kind: 'throw',
        phase: 'always',
        detail: 'keychain/purchases/etc. throw on require',
      };
  }
}

// ------------------------------------------------------------- fake DB ----

type Row = Record<string, unknown>;

export interface DbCallLog {
  op: 'shots' | 'kvRead' | 'kvWrite' | 'other';
  sql: string;
  params: unknown[];
  outcome: string;
}

export interface FakeDbController {
  db: LocalDb;
  kv: Map<string, string>;
  calls: DbCallLog[];
  /** Fault currently armed for db operations (null = healthy). */
  armed: Fault | null;
  /** Whether getDb() itself should throw. */
  getDbThrows: boolean;
  /** How many getDb() calls were refused. */
  getDbThrowCount: number;
  /** Number of refreshes-worth of loads observed (counts shots SELECTs). */
  loadCount: number;
  /** Settle every still-pending 'never' promise (used at teardown). */
  releasePending(): void;
  pendingCount(): number;
}

function classify(sql: string): DbCallLog['op'] {
  if (/FROM local_shot/i.test(sql)) return 'shots';
  if (/SELECT value FROM kv/i.test(sql)) return 'kvRead';
  if (/INTO kv/i.test(sql)) return 'kvWrite';
  return 'other';
}

function malformedShotRows(variant: string, fixture: Fixture): Row[] {
  const good = fixture.shots.map(shotRow);
  switch (variant) {
    case 'null-columns':
      return [
        ...good,
        {
          id: null,
          session_id: null,
          shot_type: null,
          captured_at: null,
          overall_score: null,
          result_kind: null,
        },
      ];
    case 'wrong-types':
      return [
        ...good,
        {
          id: 42,
          session_id: 7,
          shot_type: 3.5,
          captured_at: 1_700_000_000_000,
          overall_score: '9.1',
          result_kind: true,
        },
      ];
    case 'garbage-dates':
      return [
        ...good,
        {
          id: 'g1',
          session_id: null,
          shot_type: 'dink',
          captured_at: 'not-a-date',
          overall_score: 5,
          result_kind: 'scored',
        },
        {
          id: 'g2',
          session_id: null,
          shot_type: 'dink',
          captured_at: '9999-99-99T99:99:99Z',
          overall_score: 5,
          result_kind: 'scored',
        },
        {
          id: 'g3',
          session_id: null,
          shot_type: 'dink',
          captured_at: '',
          overall_score: 5,
          result_kind: 'scored',
        },
      ];
    case 'nan-scores':
      return [
        ...good,
        {
          id: 'n1',
          session_id: null,
          shot_type: 'drive',
          captured_at: fixture.nowIso,
          overall_score: Number.NaN,
          result_kind: 'scored',
        },
        {
          id: 'n2',
          session_id: null,
          shot_type: 'drive',
          captured_at: fixture.nowIso,
          overall_score: Number.POSITIVE_INFINITY,
          result_kind: 'scored',
        },
        {
          id: 'n3',
          session_id: null,
          shot_type: 'drive',
          captured_at: fixture.nowIso,
          overall_score: -1e308,
          result_kind: 'scored',
        },
      ];
    case 'object-values':
      return [
        ...good,
        {
          id: { nested: true },
          session_id: [1, 2],
          shot_type: { toString: () => 'weird' },
          captured_at: { iso: fixture.nowIso },
          overall_score: [7],
          result_kind: Symbol.for('scored') as unknown,
        },
      ];
    case 'huge': {
      const rows: Row[] = [];
      for (let i = 0; i < 5000; i++) {
        rows.push({
          id: `huge-${i}`,
          session_id: null,
          shot_type: SHOT_TYPES[i % SHOT_TYPES.length],
          captured_at: new Date(
            Date.parse(fixture.nowIso) - (i % 400) * DAY_MS,
          ).toISOString(),
          overall_score: (i % 100) / 10,
          result_kind: 'scored',
        });
      }
      return rows;
    }
    default:
      return good;
  }
}

function malformedKvValue(variant: string, fixture: Fixture): string {
  switch (variant) {
    case 'truncated-json':
      return fixture.ledgerRaw.slice(
        0,
        Math.max(1, fixture.ledgerRaw.length >> 1),
      );
    case 'array':
      return '[]';
    case 'null-literal':
      return 'null';
    case 'number':
      return '42';
    case 'wrong-field-types':
      return JSON.stringify({
        version: '1',
        drills: 'not-an-array',
        celebrated: [1, 2, 3],
        daySecuredShownDay: 12345,
      });
    case 'drills-missing-ids':
      return JSON.stringify({
        version: 1,
        drills: [
          { slug: 'x', title: 'No id', completedAtIso: fixture.nowIso },
          { id: 'only-id' },
          null,
          'string-entry',
          { id: 'ok', slug: 's', title: 'Ok', completedAtIso: fixture.nowIso },
        ],
        celebrated: {},
        daySecuredShownDay: null,
      });
    case 'celebrated-non-string':
      return JSON.stringify({
        version: 1,
        drills: fixture.drills,
        celebrated: { 'streak.3': 3, 'streak.7': null, 'streak.1': { x: 1 } },
        daySecuredShownDay: null,
      });
    case 'binary-garbage':
      return '\u0000\u0001\uFFFD{{{{garbage\u0000';
    case 'huge-ledger': {
      const drills = [];
      for (let i = 0; i < 20_000; i++) {
        drills.push({
          id: `d${i}`,
          slug: `s${i}`,
          title: `Drill ${i}`,
          completedAtIso: new Date(
            Date.parse(fixture.nowIso) - (i % 800) * DAY_MS,
          ).toISOString(),
        });
      }
      return JSON.stringify({
        version: 1,
        drills,
        celebrated: {},
        daySecuredShownDay: null,
      });
    }
    case 'future-version':
      return JSON.stringify({
        version: 99,
        drills: fixture.drills,
        celebrated: fixture.celebrated,
        daySecuredShownDay: fixture.daySecuredShownDay,
        futureField: { nested: [1, 2, 3] },
      });
    default:
      return fixture.ledgerRaw;
  }
}

function shotRow(shot: FixtureShot): Row {
  return {
    id: shot.id,
    session_id: shot.sessionId,
    shot_type: shot.shotType,
    captured_at: shot.capturedAt,
    overall_score: shot.overallScore,
    result_kind: shot.resultKind,
  };
}

function partialShotRows(fixture: Fixture): Row[] {
  // Rows that lost columns (schema drift / partial migration).
  return fixture.shots.map((shot, i) => {
    const row = shotRow(shot);
    if (i % 3 === 0) delete row['overall_score'];
    if (i % 4 === 0) delete row['result_kind'];
    if (i % 5 === 0) delete row['captured_at'];
    if (i % 7 === 0) delete row['shot_type'];
    return row;
  });
}

function delayMs(detail: string, fallback: number): number {
  const match = /^(\d+)s$/.exec(detail);
  return match ? Number(match[1]) * 1000 : fallback;
}

export const NEIGHBOUR_KEY = 'consistency:00000000-0000-4000-8000-000000000000';
export const NEIGHBOUR_LEDGER =
  '{"version":1,"drills":[],"celebrated":{"streak.1":"2025-01-01"},"daySecuredShownDay":null}';

export function createFakeDb(fixture: Fixture): FakeDbController {
  const kv = new Map<string, string>();
  kv.set(`consistency:${fixture.owner}`, fixture.ledgerRaw);
  // A neighbour owner's ledger that must never be touched.
  kv.set(NEIGHBOUR_KEY, NEIGHBOUR_LEDGER);

  const pending: Array<() => void> = [];
  const calls: DbCallLog[] = [];

  const controller: FakeDbController = {
    kv,
    calls,
    armed: null,
    getDbThrows: false,
    getDbThrowCount: 0,
    loadCount: 0,
    releasePending() {
      while (pending.length > 0) pending.shift()!();
    },
    pendingCount() {
      return pending.length;
    },
    db: {
      execute(sql: string, params: unknown[] = []) {
        const op = classify(sql);
        if (op === 'shots') controller.loadCount += 1;
        const armed = controller.armed;
        const faultApplies =
          armed !== null &&
          ((op === 'shots' && armed.target === 'sqlite.shots') ||
            (op === 'kvRead' && armed.target === 'sqlite.kvRead') ||
            (op === 'kvWrite' && armed.target === 'sqlite.kvWrite'));

        const healthy = (): { rows: Row[] } => {
          if (op === 'shots') {
            const owner = String(params[0]);
            return {
              rows: owner === fixture.owner ? fixture.shots.map(shotRow) : [],
            };
          }
          if (op === 'kvRead') {
            const value = kv.get(String(params[0]));
            return { rows: value === undefined ? [] : [{ value }] };
          }
          if (op === 'kvWrite') {
            kv.set(String(params[0]), String(params[1]));
            return { rows: [] };
          }
          return { rows: [] };
        };

        if (!faultApplies || armed === null) {
          calls.push({ op, sql, params, outcome: 'ok' });
          return Promise.resolve(healthy());
        }

        calls.push({
          op,
          sql,
          params,
          outcome: `${armed.kind}:${armed.detail}`,
        });
        // A one-shot fault disarms itself once it fired so the next attempt
        // sees a healthy database; 'always' stays until the harness clears it.
        if (armed.phase !== 'always') controller.armed = null;

        switch (armed.kind) {
          case 'throw':
            throw new Error(`injected sync throw on ${op}`);
          case 'reject':
            return Promise.reject(new Error(`injected rejection on ${op}`));
          case 'slow':
          case 'timeout':
            return new Promise(resolve => {
              setTimeout(
                () => resolve(healthy()),
                delayMs(armed.detail, armed.kind === 'slow' ? 3000 : 45_000),
              );
            });
          case 'never':
            return new Promise((_resolve, reject) => {
              pending.push(() =>
                reject(new Error(`released hung ${op} at teardown`)),
              );
            });
          case 'malformed':
            if (op === 'shots') {
              return Promise.resolve({
                rows: malformedShotRows(armed.detail, fixture),
              });
            }
            if (op === 'kvRead') {
              return Promise.resolve({
                rows: [{ value: malformedKvValue(armed.detail, fixture) }],
              });
            }
            return Promise.resolve(healthy());
          case 'partial':
            if (op === 'shots') {
              return Promise.resolve({ rows: partialShotRows(fixture) });
            }
            if (op === 'kvRead') {
              return Promise.resolve({
                rows: [{ value: JSON.stringify({ drills: fixture.drills }) }],
              });
            }
            return Promise.resolve(healthy());
        }
      },
      close() {},
    },
  };
  return controller;
}

/**
 * A malformed/partial ledger is modelled as PERSISTED corruption (SQLite
 * returns what it stores), so these kinds replace the stored value instead
 * of faulting the read. Returns the value the store will actually parse.
 */
export function kvValueUnderFault(
  fixture: Fixture,
  fault: Fault | null,
): string {
  if (!fault || fault.target !== 'sqlite.kvRead') return fixture.ledgerRaw;
  if (fault.kind === 'malformed')
    return malformedKvValue(fault.detail, fixture);
  if (fault.kind === 'partial')
    return JSON.stringify({ drills: fixture.drills });
  return fixture.ledgerRaw;
}

export function isPersistedCorruption(fault: Fault): boolean {
  return (
    fault.target === 'sqlite.kvRead' &&
    (fault.kind === 'malformed' || fault.kind === 'partial')
  );
}

// ----------------------------------------------------- ledger integrity ----

export interface LedgerCheck {
  ok: boolean;
  reason: string;
}

/**
 * The persisted ledger may only ever grow: every original drill id and every
 * original celebrated id must survive, the JSON must parse, and
 * daySecuredShownDay may only stay or move to `today`.
 */
export function checkLedgerIntegrity(
  original: string,
  current: string | undefined,
  today: string,
): LedgerCheck {
  if (current === undefined) return { ok: false, reason: 'ledger key deleted' };
  if (current === original) return { ok: true, reason: 'untouched' };
  let after: Record<string, unknown>;
  let parsedOriginal: unknown;
  try {
    parsedOriginal = JSON.parse(original);
  } catch {
    parsedOriginal = null;
  }
  if (
    parsedOriginal === null ||
    typeof parsedOriginal !== 'object' ||
    Array.isArray(parsedOriginal)
  ) {
    // Original was deliberately malformed; any valid JSON replacement is fine.
    try {
      JSON.parse(current);
      return { ok: true, reason: 'malformed original replaced by valid json' };
    } catch {
      return { ok: false, reason: 'ledger still not JSON after write' };
    }
  }
  const before = parsedOriginal as Record<string, unknown>;
  try {
    after = JSON.parse(current) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'ledger no longer parses' };
  }
  if (after['version'] !== 1)
    return { ok: false, reason: `version ${String(after['version'])}` };
  // Only drills the store could legitimately keep (id + completion instant)
  // must survive; entries missing either are sanitised away on purpose.
  type DrillLike = { id?: unknown; completedAtIso?: unknown };
  const beforeDrills = Array.isArray(before['drills'])
    ? (before['drills'] as DrillLike[])
    : [];
  const afterDrills = Array.isArray(after['drills'])
    ? (after['drills'] as DrillLike[])
    : [];
  const afterIds = new Set(afterDrills.map(d => (d ? d.id : undefined)));
  for (const drill of beforeDrills) {
    if (
      drill &&
      typeof drill.id === 'string' &&
      typeof drill.completedAtIso === 'string' &&
      !afterIds.has(drill.id)
    ) {
      return { ok: false, reason: `drill ${drill.id} lost` };
    }
  }
  const beforeCel = (before['celebrated'] ?? {}) as Record<string, unknown>;
  const afterCel = (after['celebrated'] ?? {}) as Record<string, unknown>;
  if (
    typeof afterCel !== 'object' ||
    afterCel === null ||
    Array.isArray(afterCel)
  ) {
    return { ok: false, reason: 'celebrated is not an object' };
  }
  for (const [id, day] of Object.entries(beforeCel)) {
    if (typeof day !== 'string') continue;
    if (afterCel[id] !== day)
      return { ok: false, reason: `celebrated ${id} changed/lost` };
  }
  for (const day of Object.values(afterCel)) {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return { ok: false, reason: 'celebrated value is not a day key' };
    }
  }
  const shownBefore = before['daySecuredShownDay'];
  const shownAfter = after['daySecuredShownDay'];
  if (
    shownAfter !== null &&
    shownAfter !== shownBefore &&
    shownAfter !== today
  ) {
    return { ok: false, reason: `daySecuredShownDay ${String(shownAfter)}` };
  }
  return { ok: true, reason: 'grew monotonically' };
}

// ------------------------------------------------------------ results ----

export type Outcome = 'HELD' | 'BROKEN';

export interface IterationResult {
  seed: number;
  fixture: {
    owner: string;
    nowIso: string;
    timeZone: string;
    shots: number;
    drills: number;
    celebrated: string[];
  };
  fault: Fault;
  /** False when the seed never reached the faulted code path. */
  faultFired: boolean;
  outcome: Outcome;
  /** Invariant names that held / broke. */
  held: string[];
  broken: string[];
  observed: string;
  durationMs: number;
}
