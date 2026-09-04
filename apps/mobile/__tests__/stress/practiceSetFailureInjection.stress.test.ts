/**
 * STRESS — failure injection for `src/analysis/practiceSet.ts`.
 *
 * Every dependency the module reaches — the SQLite kv read/write, the
 * session transaction (BEGIN / local_session / outbox / COMMIT / ROLLBACK),
 * the clock (injected `nowIso` AND the wall clock), the uuid generator and
 * the active data owner — is driven through throw / reject / slow /
 * never-resolves / malformed / partial, one operation at a time (catalog) and
 * as seeded random sequences over one shared database (sitting simulation).
 *
 * Invariants checked after every iteration:
 *  - planPracticeSet / currentPracticeSetId are READ-ONLY, whatever fails;
 *  - a settled call either returns a typed value or throws an Error — never a
 *    plan with an empty / non-string sessionId or a foreign owner;
 *  - the session transaction is atomic: `local_session` rows and
 *    `session.create` outbox rows always come in matched pairs, and no
 *    transaction is left open once the call has settled;
 *  - the kv record is always either absent or a fully valid StoredPracticeSet
 *    (never a partial or foreign-owner write) and, once written, names a
 *    session that exists locally unless it was an externally supplied
 *    (TRY AGAIN) id;
 *  - a signed-out owner never reads or writes anything;
 *  - a bounded call settles well before 60s of fake time; a never-resolving
 *    local dependency is reported as OBSERVED_hang_no_timeout, not as a pass.
 *
 * Campaigns: catalog (every fault × every applicable operation), STRESS_ITER
 * seeded sitting simulations (STRESS_STEPS steps each). Replay a single seed
 * with STRESS_SEED=<n>; write the seed→outcome table with
 * STRESS_REPORT=/abs/path.json.
 */

import { writeFileSync } from 'fs';
import type { ShotTypeSlug } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  commitPracticeSet,
  currentPracticeSetId,
  notePracticeSetAnalysis,
  planPracticeSet,
  practiceSetKeyForOwner,
  PRACTICE_SET_IDLE_TIMEOUT_MS,
  PRACTICE_SET_MODE,
  resumeOrStartPracticeSet,
  type PracticeSetPlan,
  type StoredPracticeSet,
} from '../../src/analysis/practiceSet';

jest.mock('../../src/util/uuid', () => {
  const actual = jest.requireActual<typeof import('../../src/util/uuid')>(
    '../../src/util/uuid',
  );
  return {
    ...actual,
    makeUuid: () => mockUuidHook(actual.makeUuid as () => string),
  };
});

let mockUuidHook: (real: () => string) => string = real => real();

const STRESS_ITER = Number(process.env['STRESS_ITER'] ?? 24);
const STRESS_STEPS = Number(process.env['STRESS_STEPS'] ?? 12);
const STRESS_SEED = process.env['STRESS_SEED']
  ? Number(process.env['STRESS_SEED'])
  : null;
const STRESS_REPORT = process.env['STRESS_REPORT'] ?? null;
const SETTLE_WINDOW_MS = 60_000;

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-09-04T12:00:00.000Z');

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

// ─── Fake SQLite with a real kv table + atomic transactions ─────────────────

type DbMode = 'throw' | 'reject' | 'slow' | 'never';

interface DbFault {
  match: string;
  mode: DbMode;
  delayMs?: number;
  /** Fire only on the Nth matching statement (1-based); default every. */
  nth?: number;
  /** Fire at most once (the first matching statement). */
  once?: boolean;
}

type KvReadShape =
  | 'rows_undefined'
  | 'rows_not_array'
  | 'row_missing_value'
  | 'value_number'
  | 'value_object'
  | 'value_empty_string';

interface SessionRow {
  owner: string;
  id: string;
  mode: string;
  shotType: string | null;
  startedAt: string;
}

interface OutboxRow {
  owner: string;
  kind: string;
  payload: string;
}

class FakeSqlite {
  readonly kv = new Map<string, string>();
  readonly sessions: SessionRow[] = [];
  readonly outbox: OutboxRow[] = [];
  readonly log: string[] = [];
  writes = 0;
  reads = 0;
  faultHits = 0;
  txnOpen = false;
  private staged: { sessions: SessionRow[]; outbox: OutboxRow[] } | null = null;
  private counts = new Map<string, number>();
  kvReadShape: KvReadShape | null = null;
  /** Bypasses the stored value for the next kv read (driver-level fault). */
  constructor(readonly faults: DbFault[]) {}

  readonly db: LocalDb = {
    execute: (sql: string, params: unknown[] = []) => this.execute(sql, params),
    close() {},
  };

  private execute(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const flat = sql.replace(/\s+/g, ' ').trim();
    this.log.push(flat.slice(0, 50));
    for (const fault of this.faults) {
      if (!flat.includes(fault.match)) continue;
      const seen = (this.counts.get(fault.match) ?? 0) + 1;
      this.counts.set(fault.match, seen);
      if (fault.nth !== undefined && fault.nth !== seen) continue;
      if (fault.once && seen > 1) continue;
      this.faultHits += 1;
      switch (fault.mode) {
        case 'throw':
          throw new Error(`SQLITE_IOERR injected on ${fault.match}`);
        case 'reject':
          return Promise.reject(
            new Error(`SQLITE_BUSY injected on ${fault.match}`),
          );
        case 'never':
          return new Promise(() => {});
        case 'slow':
          return new Promise(resolve =>
            setTimeout(
              () => resolve(this.apply(flat, params)),
              fault.delayMs ?? 1_000,
            ),
          );
      }
    }
    return Promise.resolve(this.apply(flat, params));
  }

  private apply(
    flat: string,
    params: unknown[],
  ): { rows: Record<string, unknown>[] } {
    if (flat.startsWith('BEGIN')) {
      if (this.staged) {
        throw new Error('cannot start a transaction within a transaction');
      }
      this.staged = { sessions: [], outbox: [] };
      this.txnOpen = true;
      return { rows: [] };
    }
    if (flat.startsWith('COMMIT')) {
      if (this.staged) {
        this.sessions.push(...this.staged.sessions);
        this.outbox.push(...this.staged.outbox);
      }
      this.staged = null;
      this.txnOpen = false;
      return { rows: [] };
    }
    if (flat.startsWith('ROLLBACK')) {
      this.staged = null;
      this.txnOpen = false;
      return { rows: [] };
    }
    if (flat.startsWith('SELECT value FROM kv')) {
      this.reads += 1;
      const key = String(params[0]);
      const stored = this.kv.get(key);
      const shape = this.kvReadShape;
      this.kvReadShape = null;
      switch (shape) {
        case 'rows_undefined':
          return { rows: undefined as unknown as Record<string, unknown>[] };
        case 'rows_not_array':
          return {
            rows: { value: stored } as unknown as Record<string, unknown>[],
          };
        case 'row_missing_value':
          return { rows: [{}] };
        case 'value_number':
          return { rows: [{ value: 42 }] };
        case 'value_object':
          return { rows: [{ value: { sessionId: 'obj' } }] };
        case 'value_empty_string':
          return { rows: [{ value: '' }] };
        default:
          return { rows: stored === undefined ? [] : [{ value: stored }] };
      }
    }
    if (flat.startsWith('INSERT OR REPLACE INTO kv')) {
      this.writes += 1;
      this.kv.set(String(params[0]), String(params[1]));
      return { rows: [] };
    }
    if (flat.startsWith('INSERT OR REPLACE INTO local_session')) {
      this.writes += 1;
      const row: SessionRow = {
        owner: String(params[0]),
        id: String(params[1]),
        mode: String(params[2]),
        shotType: params[3] === null ? null : String(params[3]),
        startedAt: String(params[5]),
      };
      (this.staged?.sessions ?? this.sessions).push(row);
      return { rows: [] };
    }
    if (flat.startsWith('INSERT INTO outbox')) {
      this.writes += 1;
      const kind = /'([a-z.]+)'/.exec(flat)?.[1] ?? 'unknown';
      const row: OutboxRow = {
        owner: String(params[0]),
        kind,
        payload: String(params[1]),
      };
      (this.staged?.outbox ?? this.outbox).push(row);
      return { rows: [] };
    }
    throw new Error(`fake sqlite: unexpected statement ${flat}`);
  }
}

// ─── Scenario + fault catalog ───────────────────────────────────────────────

type Operation =
  | 'plan_fresh'
  | 'plan_live'
  | 'plan_stale'
  | 'plan_preferred'
  | 'commit_new'
  | 'commit_resumed'
  | 'note'
  | 'current'
  | 'resume_or_start';

const OPERATIONS: readonly Operation[] = [
  'plan_fresh',
  'plan_live',
  'plan_stale',
  'plan_preferred',
  'commit_new',
  'commit_resumed',
  'note',
  'current',
  'resume_or_start',
];

interface Scenario {
  dbFaults: DbFault[];
  kvReadShape: KvReadShape | null;
  /** Raw kv record seeded for OWNER_A before the operation (null = none). */
  storedRaw: string | null | 'default';
  nowIso: string | undefined | 'invalid_wall_clock';
  uuidHook: (real: () => string) => string;
  ownerAtCall: string;
  /** Owner switched to this value between plan and commit. */
  ownerAtCommit: string | null;
  /** A local dependency was told to never resolve — a hang is the expected
   * observation for this scenario, not a pass. */
  localNever: boolean;
}

interface Fault {
  id: string;
  dependency:
    | 'sqlite_kv_read'
    | 'sqlite_kv_write'
    | 'sqlite_session_txn'
    | 'clock'
    | 'uuid_crypto'
    | 'owner';
  /** Operations this fault is meaningful for (default: all). */
  ops?: readonly Operation[];
  apply: (scenario: Scenario, rng: () => number) => void;
}

const WRITE_OPS: readonly Operation[] = [
  'commit_new',
  'commit_resumed',
  'note',
  'resume_or_start',
];
const NEW_SESSION_OPS: readonly Operation[] = ['commit_new', 'resume_or_start'];
const READ_OPS: readonly Operation[] = [
  'plan_fresh',
  'plan_live',
  'plan_stale',
  'plan_preferred',
  'commit_resumed',
  'note',
  'current',
  'resume_or_start',
];
/** Operations whose stored record is supplied by the fault itself. */
const STORED_OPS: readonly Operation[] = [
  'plan_fresh',
  'plan_preferred',
  'note',
  'current',
  'resume_or_start',
];

const liveStored = (): StoredPracticeSet => ({
  sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  shotType: 'dink',
  startedAtIso: new Date(T0 - 5 * 60_000).toISOString(),
  lastActivityAtIso: new Date(T0 - 60_000).toISOString(),
});

const dbFault =
  (match: string, mode: DbMode, extra: Partial<DbFault> = {}) =>
  (s: Scenario, rng: () => number): void => {
    if (mode === 'never') s.localNever = true;
    s.dbFaults.push({
      match,
      mode,
      delayMs: 500 + Math.floor(rng() * 20_000),
      ...extra,
    });
  };

const storedRaw =
  (raw: string): Fault['apply'] =>
  s => {
    s.storedRaw = raw;
  };
const stored = (id: string, raw: string): Fault => ({
  id: `kv_stored.${id}`,
  dependency: 'sqlite_kv_read',
  ops: STORED_OPS,
  apply: storedRaw(raw),
});

const FAULT_CATALOG: readonly Fault[] = [
  // kv read — driver
  {
    id: 'kv_read.throw',
    dependency: 'sqlite_kv_read',
    ops: READ_OPS,
    apply: dbFault('SELECT value FROM kv', 'throw'),
  },
  {
    id: 'kv_read.reject',
    dependency: 'sqlite_kv_read',
    ops: READ_OPS,
    apply: dbFault('SELECT value FROM kv', 'reject'),
  },
  {
    id: 'kv_read.slow',
    dependency: 'sqlite_kv_read',
    ops: READ_OPS,
    apply: dbFault('SELECT value FROM kv', 'slow'),
  },
  {
    id: 'kv_read.never',
    dependency: 'sqlite_kv_read',
    ops: READ_OPS,
    apply: dbFault('SELECT value FROM kv', 'never'),
  },
  ...(
    [
      'rows_undefined',
      'rows_not_array',
      'row_missing_value',
      'value_number',
      'value_object',
      'value_empty_string',
    ] as const
  ).map(shape => ({
    id: `kv_read.${shape}`,
    dependency: 'sqlite_kv_read' as const,
    ops: READ_OPS,
    apply: (s: Scenario) => {
      s.kvReadShape = shape;
    },
  })),
  // kv read — malformed / partial stored record
  stored('corrupt_json', '{"sessionId":"aaaa","shotType":"dink","start'),
  stored('json_array', '["aaaa"]'),
  stored('json_null', 'null'),
  stored('json_string', '"aaaa"'),
  stored(
    'missing_session',
    JSON.stringify({
      shotType: 'dink',
      startedAtIso: 'x',
      lastActivityAtIso: 'y',
    }),
  ),
  stored('empty_session', JSON.stringify({ ...liveStored(), sessionId: '' })),
  stored('numeric_session', JSON.stringify({ ...liveStored(), sessionId: 12 })),
  stored('numeric_shot_type', JSON.stringify({ ...liveStored(), shotType: 7 })),
  stored(
    'missing_activity',
    JSON.stringify({
      sessionId: 'aaaa',
      shotType: null,
      startedAtIso: new Date(T0).toISOString(),
    }),
  ),
  stored(
    'garbage_activity',
    JSON.stringify({ ...liveStored(), lastActivityAtIso: 'not-a-date' }),
  ),
  stored(
    'numeric_activity',
    JSON.stringify({ ...liveStored(), lastActivityAtIso: 1_700_000_000_000 }),
  ),
  stored(
    'future_activity',
    JSON.stringify({
      ...liveStored(),
      lastActivityAtIso: new Date(T0 + 60_000).toISOString(),
    }),
  ),
  stored(
    'activity_at_timeout_edge',
    JSON.stringify({
      ...liveStored(),
      lastActivityAtIso: new Date(
        T0 - PRACTICE_SET_IDLE_TIMEOUT_MS,
      ).toISOString(),
    }),
  ),
  stored(
    'activity_past_timeout_by_1ms',
    JSON.stringify({
      ...liveStored(),
      lastActivityAtIso: new Date(
        T0 - PRACTICE_SET_IDLE_TIMEOUT_MS - 1,
      ).toISOString(),
    }),
  ),
  stored(
    'huge_record',
    JSON.stringify({ ...liveStored(), shotType: 'x'.repeat(1_000_000) }),
  ),
  stored(
    'proto_pollution',
    '{"__proto__":{"sessionId":"evil"},"sessionId":"aaaa","shotType":null,"startedAtIso":"2026-09-04T11:00:00.000Z","lastActivityAtIso":"2026-09-04T11:59:00.000Z"}',
  ),
  {
    id: 'kv_stored.other_owner_only',
    dependency: 'sqlite_kv_read',
    ops: STORED_OPS,
    apply: s => {
      s.storedRaw = null;
      s.ownerAtCall = OWNER_B;
    },
  },
  // kv write
  {
    id: 'kv_write.throw',
    dependency: 'sqlite_kv_write',
    ops: WRITE_OPS,
    apply: dbFault('INSERT OR REPLACE INTO kv', 'throw'),
  },
  {
    id: 'kv_write.reject',
    dependency: 'sqlite_kv_write',
    ops: WRITE_OPS,
    apply: dbFault('INSERT OR REPLACE INTO kv', 'reject'),
  },
  {
    id: 'kv_write.slow',
    dependency: 'sqlite_kv_write',
    ops: WRITE_OPS,
    apply: dbFault('INSERT OR REPLACE INTO kv', 'slow'),
  },
  {
    id: 'kv_write.never',
    dependency: 'sqlite_kv_write',
    ops: WRITE_OPS,
    apply: dbFault('INSERT OR REPLACE INTO kv', 'never'),
  },
  // session transaction
  ...(
    [
      ['BEGIN IMMEDIATE', 'begin'],
      ['INSERT OR REPLACE INTO local_session', 'local_session'],
      ["'session.create'", 'session_create_outbox'],
      ['COMMIT', 'commit'],
    ] as const
  ).flatMap(([match, label]) =>
    (['throw', 'reject', 'slow', 'never'] as const).map(mode => ({
      id: `session_txn.${label}.${mode}`,
      dependency: 'sqlite_session_txn' as const,
      ops: NEW_SESSION_OPS,
      apply: dbFault(match, mode),
    })),
  ),
  {
    id: 'session_txn.outbox_fails_then_rollback_throws',
    dependency: 'sqlite_session_txn',
    ops: NEW_SESSION_OPS,
    apply: (s, rng) => {
      dbFault("'session.create'", 'reject')(s, rng);
      dbFault('ROLLBACK', 'throw')(s, rng);
    },
  },
  {
    id: 'session_txn.commit_and_rollback_both_reject',
    dependency: 'sqlite_session_txn',
    ops: NEW_SESSION_OPS,
    apply: (s, rng) => {
      dbFault('COMMIT', 'reject')(s, rng);
      dbFault('ROLLBACK', 'reject')(s, rng);
    },
  },
  // clock — injected nowIso
  {
    id: 'clock.now_garbage',
    dependency: 'clock',
    apply: s => {
      s.nowIso = 'yesterday-ish';
    },
  },
  {
    id: 'clock.now_empty',
    dependency: 'clock',
    apply: s => {
      s.nowIso = '';
    },
  },
  {
    id: 'clock.now_impossible_date',
    dependency: 'clock',
    apply: s => {
      s.nowIso = '2026-13-45T99:99:99.000Z';
    },
  },
  {
    id: 'clock.now_epoch_zero',
    dependency: 'clock',
    apply: s => {
      s.nowIso = '1970-01-01T00:00:00.000Z';
    },
  },
  {
    id: 'clock.now_far_future',
    dependency: 'clock',
    apply: s => {
      s.nowIso = '+275760-09-13T00:00:00.000Z';
    },
  },
  {
    id: 'clock.now_before_stored',
    dependency: 'clock',
    apply: s => {
      s.nowIso = new Date(T0 - 10 * 60_000).toISOString();
    },
  },
  {
    id: 'clock.wall_clock_invalid',
    dependency: 'clock',
    apply: s => {
      s.nowIso = 'invalid_wall_clock';
    },
  },
  {
    id: 'clock.wall_clock_default',
    dependency: 'clock',
    apply: s => {
      s.nowIso = undefined;
    },
  },
  // uuid
  {
    id: 'uuid.throw',
    dependency: 'uuid_crypto',
    ops: ['plan_fresh', 'plan_stale', 'resume_or_start'],
    apply: s => {
      s.uuidHook = () => {
        throw new Error('crypto.getRandomValues unavailable');
      };
    },
  },
  // owner
  {
    id: 'owner.signed_out',
    dependency: 'owner',
    apply: s => {
      s.ownerAtCall = SIGNED_OUT_DATA_OWNER;
    },
  },
  {
    id: 'owner.guest',
    dependency: 'owner',
    apply: s => {
      s.ownerAtCall = GUEST_DATA_OWNER;
    },
  },
  {
    id: 'owner.switched_before_commit',
    dependency: 'owner',
    ops: ['commit_new', 'commit_resumed'],
    apply: s => {
      s.ownerAtCommit = OWNER_B;
    },
  },
  {
    id: 'owner.signed_out_before_commit',
    dependency: 'owner',
    ops: ['commit_new', 'commit_resumed'],
    apply: s => {
      s.ownerAtCommit = SIGNED_OUT_DATA_OWNER;
    },
  },
];

const FAULT_BY_ID = new Map(FAULT_CATALOG.map(f => [f.id, f]));

function freshScenario(): Scenario {
  return {
    dbFaults: [],
    kvReadShape: null,
    storedRaw: 'default',
    nowIso: new Date(T0).toISOString(),
    uuidHook: real => real(),
    ownerAtCall: OWNER_A,
    ownerAtCommit: null,
    localNever: false,
  };
}

// ─── Settlement under fake timers ───────────────────────────────────────────

type Settled<T> =
  | { state: 'resolved'; value: T }
  | { state: 'rejected'; error: unknown }
  | { state: 'pending' };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  let settled: Settled<T> = { state: 'pending' };
  promise.then(
    value => {
      settled = { state: 'resolved', value };
    },
    error => {
      settled = { state: 'rejected', error };
    },
  );
  for (let i = 0; i < 8 && settled.state === 'pending'; i++) {
    await Promise.resolve();
  }
  let elapsed = 0;
  while (settled.state === 'pending' && elapsed < SETTLE_WINDOW_MS) {
    await jest.advanceTimersByTimeAsync(1_000);
    elapsed += 1_000;
  }
  return settled;
}

// ─── One operation under one scenario ───────────────────────────────────────

interface StepResult {
  op: Operation;
  outcome: string;
  violations: string[];
  observations: string[];
}

interface IterationResult {
  seed: number;
  campaign: 'catalog' | 'sitting';
  faults: string[];
  steps: StepResult[];
  kvAfter: Record<string, string | null>;
  sessions: number;
  sessionCreates: number;
  txnOpen: boolean;
  classification:
    | 'HELD'
    | 'BROKEN'
    | 'OBSERVED_hang_no_timeout'
    | 'OBSERVED_orphan_session_ref'
    | 'OBSERVED_txn_open_after_rollback_fault';
}

function parseStored(
  raw: string | undefined,
): StoredPracticeSet | 'invalid' | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof parsed['sessionId'] !== 'string' ||
      parsed['sessionId'].length === 0 ||
      typeof parsed['startedAtIso'] !== 'string' ||
      typeof parsed['lastActivityAtIso'] !== 'string' ||
      (parsed['shotType'] !== null && typeof parsed['shotType'] !== 'string')
    ) {
      return 'invalid';
    }
    return parsed as unknown as StoredPracticeSet;
  } catch {
    return 'invalid';
  }
}

function seedStored(
  sqlite: FakeSqlite,
  scenario: Scenario,
  op: Operation,
): void {
  const owner =
    scenario.ownerAtCall === SIGNED_OUT_DATA_OWNER
      ? OWNER_A
      : scenario.ownerAtCall;
  const key = practiceSetKeyForOwner(owner);
  if (scenario.storedRaw === null) return;
  if (scenario.storedRaw !== 'default') {
    sqlite.kv.set(key, scenario.storedRaw);
    return;
  }
  switch (op) {
    case 'plan_live':
    case 'commit_resumed':
    case 'note':
    case 'current':
    case 'plan_preferred':
      sqlite.kv.set(key, JSON.stringify(liveStored()));
      // The stored set has a real session row locally (the normal state).
      sqlite.sessions.push({
        owner,
        id: liveStored().sessionId,
        mode: PRACTICE_SET_MODE,
        shotType: 'dink',
        startedAt: liveStored().startedAtIso,
      });
      sqlite.outbox.push({
        owner,
        kind: 'session.create',
        payload: JSON.stringify({ id: liveStored().sessionId }),
      });
      break;
    case 'plan_stale':
      sqlite.kv.set(
        key,
        JSON.stringify({
          ...liveStored(),
          lastActivityAtIso: new Date(
            T0 - PRACTICE_SET_IDLE_TIMEOUT_MS - 60_000,
          ).toISOString(),
        }),
      );
      break;
    default:
      break;
  }
}

function nowArg(scenario: Scenario): string | undefined {
  if (scenario.nowIso === 'invalid_wall_clock') return undefined;
  return scenario.nowIso;
}

function installClock(scenario: Scenario): void {
  if (scenario.nowIso === 'invalid_wall_clock') {
    // A wall clock outside the ECMAScript date range: `new Date()` is Invalid
    // and `toISOString()` throws RangeError.
    jest.setSystemTime(new Date(8.64e15 + 1));
  } else {
    jest.setSystemTime(new Date(T0));
  }
}

async function runOperation(
  sqlite: FakeSqlite,
  scenario: Scenario,
  op: Operation,
  shotType: ShotTypeSlug | null = 'dink',
): Promise<StepResult> {
  const violations: string[] = [];
  const observations: string[] = [];
  const writesBefore = sqlite.writes;
  const kvBefore = new Map(sqlite.kv);
  const sessionsBefore = sqlite.sessions.length;
  const outboxBefore = sqlite.outbox.length;
  setActiveDataOwner(scenario.ownerAtCall);
  sqlite.kvReadShape = scenario.kvReadShape;
  mockUuidHook = scenario.uuidHook;
  installClock(scenario);
  const nowIso = nowArg(scenario);
  const signedOut = scenario.ownerAtCall === SIGNED_OUT_DATA_OWNER;
  const readOnly = op.startsWith('plan_') || op === 'current';

  let outcome: string;
  let settled: Settled<unknown>;
  let plan: PracticeSetPlan | null = null;
  let switchedOwner = false;
  switch (op) {
    case 'plan_fresh':
    case 'plan_live':
    case 'plan_stale':
    case 'plan_preferred': {
      const preferred =
        op === 'plan_preferred' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : null;
      settled = await settle(
        planPracticeSet(sqlite.db, {
          shotType,
          nowIso,
          preferredSessionId: preferred,
        }),
      );
      break;
    }
    case 'commit_new':
    case 'commit_resumed': {
      // Plan first under clean conditions (the caller does this before the
      // analysis), then commit under the injected faults.
      const cleanFaults = sqlite.faults.splice(0, sqlite.faults.length);
      sqlite.kvReadShape = null;
      const planned = await planPracticeSet(sqlite.db, {
        shotType,
        nowIso: new Date(T0).toISOString(),
        preferredSessionId: null,
      });
      sqlite.faults.push(...cleanFaults);
      sqlite.kvReadShape = scenario.kvReadShape;
      if (planned === null) {
        settled = { state: 'resolved', value: null };
        break;
      }
      if (op === 'commit_new' && planned.resumed) {
        throw new Error('harness: commit_new expected a non-resumed plan');
      }
      if (op === 'commit_resumed' && !planned.resumed) {
        throw new Error('harness: commit_resumed expected a resumed plan');
      }
      plan = planned;
      if (scenario.ownerAtCommit !== null) {
        setActiveDataOwner(scenario.ownerAtCommit);
        switchedOwner = true;
      }
      settled = await settle(commitPracticeSet(sqlite.db, planned, nowIso));
      break;
    }
    case 'note':
      settled = await settle(
        notePracticeSetAnalysis(sqlite.db, liveStored().sessionId, nowIso),
      );
      break;
    case 'current':
      settled = await settle(currentPracticeSetId(sqlite.db, nowIso));
      break;
    case 'resume_or_start':
      settled = await settle(
        resumeOrStartPracticeSet(sqlite.db, { shotType, nowIso }),
      );
      break;
  }

  // ── outcome label ──
  if (settled.state === 'pending') outcome = 'pending_after_60s';
  else if (settled.state === 'rejected') {
    const e = settled.error;
    outcome = `thrown:${e instanceof Error ? e.constructor.name : typeof e}`;
    if (!(e instanceof Error))
      violations.push('rejected with a non-Error value');
  } else {
    const v = settled.value;
    if (v === null || v === undefined) outcome = 'null';
    else if (typeof v === 'string') outcome = 'id';
    else if (typeof v === 'object' && 'resumed' in v) {
      const r = v as { sessionId: string | null; resumed: boolean };
      outcome = `plan:${r.sessionId === null ? 'null' : r.resumed ? 'resumed' : 'new'}`;
    } else outcome = typeof v;
  }

  // ── invariants ──
  if (settled.state === 'pending') {
    if (!scenario.localNever) {
      violations.push('bounded call still pending after 60s of fake time');
    }
  }
  if (readOnly && sqlite.writes !== writesBefore) {
    violations.push(`${op} wrote ${sqlite.writes - writesBefore} statement(s)`);
  }
  if (signedOut) {
    if (sqlite.log.length > 0 && sqlite.reads + sqlite.writes > 0) {
      violations.push('signed-out owner touched the database');
    }
    if (settled.state === 'resolved') {
      const v = settled.value as { sessionId?: unknown } | string | null;
      if (
        v !== null &&
        v !== undefined &&
        !(typeof v === 'object' && v.sessionId === null)
      ) {
        violations.push(`signed-out owner received ${JSON.stringify(v)}`);
      }
    }
  }
  if (
    settled.state === 'resolved' &&
    settled.value &&
    typeof settled.value === 'object' &&
    'owner' in settled.value
  ) {
    const p = settled.value as PracticeSetPlan;
    if (typeof p.sessionId !== 'string' || p.sessionId.length === 0) {
      violations.push('plan with empty sessionId');
    }
    if (p.owner !== scenario.ownerAtCall)
      violations.push('plan for a foreign owner');
    if (
      !Number.isFinite(Date.parse(p.nowIso)) ||
      !Number.isFinite(Date.parse(p.startedAtIso))
    ) {
      violations.push('plan with unparseable timestamps');
    }
    if (p.resumed && op !== 'plan_preferred') {
      const before = parseStored(
        kvBefore.get(practiceSetKeyForOwner(scenario.ownerAtCall)),
      );
      if (!before || before === 'invalid' || before.sessionId !== p.sessionId) {
        violations.push('resumed a set the kv record does not name');
      } else {
        const idle =
          Date.parse(p.nowIso) - Date.parse(before.lastActivityAtIso);
        if (!(idle >= 0 && idle <= PRACTICE_SET_IDLE_TIMEOUT_MS)) {
          violations.push(`resumed a set idle for ${idle}ms`);
        }
      }
    }
  }
  // Transaction atomicity: matched pairs, none left open once settled.
  const newSessions = sqlite.sessions.length - sessionsBefore;
  const newCreates =
    sqlite.outbox.filter(r => r.kind === 'session.create').length -
    outboxBefore;
  if (newSessions !== newCreates) {
    violations.push(
      `local_session +${newSessions} but session.create +${newCreates}`,
    );
  }
  const rollbackFaulted = scenario.dbFaults.some(f => f.match === 'ROLLBACK');
  if (sqlite.txnOpen && settled.state !== 'pending') {
    if (rollbackFaulted) {
      observations.push(
        'transaction left open after COMMIT/ROLLBACK both failed',
      );
    } else {
      violations.push('transaction left open');
    }
  }
  // kv record: absent, unchanged or fully valid — never partial, never
  // under a foreign owner's key.
  for (const [key, raw] of sqlite.kv) {
    if (kvBefore.get(key) === raw) continue;
    const parsed = parseStored(raw);
    if (parsed === 'invalid')
      violations.push(`kv ${key} holds a partial/invalid record`);
    const expectedOwner =
      switchedOwner && plan ? plan.owner : scenario.ownerAtCall;
    if (key !== practiceSetKeyForOwner(expectedOwner)) {
      violations.push(`kv written under foreign key ${key}`);
    }
  }
  // Commit semantics.
  if (plan && settled.state === 'resolved') {
    if (switchedOwner && scenario.ownerAtCommit === SIGNED_OUT_DATA_OWNER) {
      observations.push(
        'commit wrote the kv record for plan.owner while the process was signed out',
      );
    }
    const stored = parseStored(
      sqlite.kv.get(practiceSetKeyForOwner(plan.owner)),
    );
    if (
      !stored ||
      stored === 'invalid' ||
      stored.sessionId !== plan.sessionId
    ) {
      violations.push('commit resolved but kv does not name the plan');
    } else if (nowIso !== undefined && stored.lastActivityAtIso !== nowIso) {
      violations.push(
        'commit resolved but activity stamp is not the commit time',
      );
    }
    if (!plan.resumed) {
      const row = sqlite.sessions.find(s => s.id === plan!.sessionId);
      if (!row)
        violations.push('commit resolved (new set) but no local_session row');
      else {
        if (row.mode !== PRACTICE_SET_MODE)
          violations.push('session row has wrong mode');
        if (switchedOwner && row.owner !== plan.owner) {
          observations.push(
            `session row written under owner ${row.owner} while kv names owner ${plan.owner}`,
          );
        }
      }
    }
  }
  if (plan && settled.state === 'rejected' && !plan.resumed) {
    // The caller already saved a scored shot with plan.sessionId (see
    // AnalyzeScreen): a failed commit leaves that shot referencing a session
    // the server will never learn about — its shot.sync is rejected with
    // `shot.session_not_found`, a TRANSIENT code, forever.
    const row = sqlite.sessions.find(s => s.id === plan!.sessionId);
    if (!row)
      observations.push(
        `orphan: scored shot would reference ${plan.sessionId} but no local_session/session.create exists`,
      );
  }
  if (settled.state === 'resolved' && op === 'resume_or_start') {
    const r = settled.value as { sessionId: string | null; resumed: boolean };
    if (r.sessionId !== null && !r.resumed) {
      if (!sqlite.sessions.some(s => s.id === r.sessionId)) {
        violations.push(
          'resumeOrStart returned a new id without a session row',
        );
      }
    }
  }
  return { op, outcome, violations, observations };
}

function classify(
  steps: StepResult[],
  sqlite: FakeSqlite,
): IterationResult['classification'] {
  if (steps.some(s => s.violations.length > 0)) return 'BROKEN';
  if (steps.some(s => s.outcome === 'pending_after_60s'))
    return 'OBSERVED_hang_no_timeout';
  if (steps.some(s => s.observations.some(o => o.startsWith('orphan'))))
    return 'OBSERVED_orphan_session_ref';
  if (sqlite.txnOpen) return 'OBSERVED_txn_open_after_rollback_fault';
  return 'HELD';
}

function snapshotKv(sqlite: FakeSqlite): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of sqlite.kv)
    out[k] = v.length > 200 ? `${v.slice(0, 200)}…(${v.length})` : v;
  return out;
}

const results: IterationResult[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(T0));
});

afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockUuidHook = real => real();
  jest.useRealTimers();
});

afterAll(() => {
  if (STRESS_REPORT) {
    writeFileSync(
      STRESS_REPORT,
      JSON.stringify(
        {
          unit: 'practiceSet',
          catalogSize: FAULT_CATALOG.length,
          iterations: results.length,
          steps: results.reduce((n, r) => n + r.steps.length, 0),
          held: results.filter(r => r.classification === 'HELD').length,
          broken: results.filter(r => r.classification === 'BROKEN').length,
          observed: results
            .filter(r => r.classification.startsWith('OBSERVED'))
            .reduce<Record<string, number>>((acc, r) => {
              acc[r.classification] = (acc[r.classification] ?? 0) + 1;
              return acc;
            }, {}),
          results,
        },
        null,
        2,
      ),
    );
  }
});

// ─── Campaign 1: catalog × applicable operations ────────────────────────────

const CATALOG_CASES: [string, Operation, number][] = [];
FAULT_CATALOG.forEach((fault, fi) => {
  (fault.ops ?? OPERATIONS).forEach((op, oi) => {
    CATALOG_CASES.push([fault.id, op, 5_000 + fi * 16 + oi]);
  });
});

describe(`practiceSet failure injection — catalog (${FAULT_CATALOG.length} faults, ${CATALOG_CASES.length} fault×operation cases)`, () => {
  it.each(
    STRESS_SEED === null
      ? CATALOG_CASES
      : CATALOG_CASES.filter(([, , seed]) => seed === STRESS_SEED),
  )(
    'fault %s during %s (seed %i): read-only plans, atomic session txn, valid kv, no fake success',
    async (faultId, op, seed) => {
      const rng = mulberry32(seed);
      const scenario = freshScenario();
      FAULT_BY_ID.get(faultId)!.apply(scenario, rng);
      const sqlite = new FakeSqlite(scenario.dbFaults);
      seedStored(sqlite, scenario, op);
      const step = await runOperation(sqlite, scenario, op);
      const result: IterationResult = {
        seed,
        campaign: 'catalog',
        faults: [faultId],
        steps: [step],
        kvAfter: snapshotKv(sqlite),
        sessions: sqlite.sessions.length,
        sessionCreates: sqlite.outbox.filter(r => r.kind === 'session.create')
          .length,
        txnOpen: sqlite.txnOpen,
        classification: classify([step], sqlite),
      };
      results.push(result);
      expect(step.violations).toEqual([]);
      if (!faultId.includes('never')) {
        expect(step.outcome).not.toBe('pending_after_60s');
      }
      // Pinned observations: only the faults known to produce them may.
      for (const o of step.observations) {
        if (o.startsWith('orphan')) {
          expect(NEW_SESSION_OPS.includes(op)).toBe(true);
          expect(
            faultId.startsWith('session_txn.') ||
              faultId.startsWith('clock.now_') ||
              faultId === 'owner.signed_out_before_commit',
          ).toBe(true);
        } else if (o.startsWith('transaction left open')) {
          expect(faultId.includes('rollback')).toBe(true);
        } else if (o.startsWith('session row written under owner')) {
          expect(faultId).toBe('owner.switched_before_commit');
        } else if (o.startsWith('commit wrote the kv record')) {
          expect(faultId).toBe('owner.signed_out_before_commit');
        } else {
          throw new Error(`unpinned observation: ${o}`);
        }
      }
    },
  );
});

// ─── Campaign 2: seeded sitting simulations over one database ───────────────

describe(`practiceSet failure injection — seeded sittings (STRESS_ITER=${STRESS_ITER} × STRESS_STEPS=${STRESS_STEPS})`, () => {
  const seeds =
    STRESS_SEED === null
      ? Array.from({ length: STRESS_ITER }, (_, i) => 60_000 + i)
      : [STRESS_SEED];
  it.each(seeds)(
    'seed %i: random plan/commit/note/current sequence with random faults and clock jumps keeps every invariant',
    async seed => {
      const rng = mulberry32(seed);
      const sqlite = new FakeSqlite([]);
      const steps: StepResult[] = [];
      const faultIds: string[] = [];
      let clockMs = T0;
      // The plan handed to the "analysis" awaiting commit, like AnalyzeScreen.
      let pendingPlan: PracticeSetPlan | null = null;
      for (let i = 0; i < STRESS_STEPS; i++) {
        // Clock: mostly forward, sometimes a jump past the idle timeout,
        // occasionally backwards.
        const r = rng();
        clockMs +=
          r < 0.1
            ? -(1 + Math.floor(rng() * 120_000))
            : r < 0.25
              ? PRACTICE_SET_IDLE_TIMEOUT_MS + Math.floor(rng() * 60_000)
              : Math.floor(rng() * 5 * 60_000);
        const scenario = freshScenario();
        scenario.storedRaw = null; // never reseed: the db carries state
        scenario.nowIso = new Date(clockMs).toISOString();
        // One fault in ~55% of the steps, drawn from the non-hanging, non-owner
        // catalog so a sitting keeps going; kv-read shapes and stored-record
        // faults are excluded here because the db already holds real state,
        // and ROLLBACK faults because whether a failed ROLLBACK leaves the
        // connection inside a transaction is a driver property this fake
        // cannot vouch for (catalog reports them as observations).
        let faultId = 'none';
        if (rng() < 0.55) {
          const eligible = FAULT_CATALOG.filter(
            f =>
              !f.id.includes('never') &&
              !f.id.includes('rollback') &&
              f.dependency !== 'owner' &&
              !f.id.startsWith('kv_stored.') &&
              !f.id.startsWith('kv_read.rows') &&
              !f.id.startsWith('kv_read.row_') &&
              !f.id.startsWith('kv_read.value_') &&
              !f.id.startsWith('clock.wall') &&
              !f.id.startsWith('clock.now_'),
          );
          const fault = pick(rng, eligible);
          faultId = fault.id;
          fault.apply(scenario, rng);
        }
        faultIds.push(faultId);
        sqlite.faults.splice(0, sqlite.faults.length, ...scenario.dbFaults);
        setActiveDataOwner(OWNER_A);
        mockUuidHook = scenario.uuidHook;
        jest.setSystemTime(new Date(clockMs));

        const writesBefore = sqlite.writes;
        const sessionsBefore = sqlite.sessions.length;
        const createsBefore = sqlite.outbox.filter(
          x => x.kind === 'session.create',
        ).length;
        const violations: string[] = [];
        const observations: string[] = [];
        let op: Operation;
        let outcome: string;
        if (pendingPlan && rng() < 0.7) {
          op = pendingPlan.resumed ? 'commit_resumed' : 'commit_new';
          const settled = await settle(
            commitPracticeSet(sqlite.db, pendingPlan, scenario.nowIso),
          );
          outcome =
            settled.state === 'resolved'
              ? 'committed'
              : settled.state === 'rejected'
                ? `thrown:${(settled.error as Error).constructor.name}`
                : 'pending_after_60s';
          if (settled.state === 'pending')
            violations.push('commit pending after 60s without a never fault');
          if (settled.state === 'resolved') {
            const stored = parseStored(
              sqlite.kv.get(practiceSetKeyForOwner(OWNER_A)),
            );
            if (
              !stored ||
              stored === 'invalid' ||
              stored.sessionId !== pendingPlan.sessionId
            ) {
              violations.push('commit resolved but kv does not name the plan');
            }
            if (
              !pendingPlan.resumed &&
              !sqlite.sessions.some(s => s.id === pendingPlan!.sessionId)
            ) {
              violations.push(
                'commit resolved (new set) but no local_session row',
              );
            }
          } else if (settled.state === 'rejected' && !pendingPlan.resumed) {
            if (!sqlite.sessions.some(s => s.id === pendingPlan!.sessionId)) {
              observations.push(
                `orphan: scored shot would reference ${pendingPlan.sessionId} with no session row`,
              );
            }
          }
          pendingPlan = null;
        } else {
          const which = rng();
          if (which < 0.5) {
            op = 'plan_fresh';
            const preferred: string | null =
              pendingPlan && rng() < 0.3 ? pendingPlan.sessionId : null;
            const settled: Settled<PracticeSetPlan | null> = await settle(
              planPracticeSet(sqlite.db, {
                shotType: pick(rng, ['dink', 'forehand_drive', null] as const),
                nowIso: scenario.nowIso,
                preferredSessionId: preferred,
              }),
            );
            if (settled.state === 'resolved') {
              const p: PracticeSetPlan | null = settled.value;
              outcome =
                p === null ? 'null' : `plan:${p.resumed ? 'resumed' : 'new'}`;
              if (p) {
                if (p.owner !== OWNER_A)
                  violations.push('plan for a foreign owner');
                if (p.resumed && preferred === null) {
                  const stored = parseStored(
                    sqlite.kv.get(practiceSetKeyForOwner(OWNER_A)),
                  );
                  if (
                    !stored ||
                    stored === 'invalid' ||
                    stored.sessionId !== p.sessionId
                  ) {
                    violations.push(
                      'resumed a set the kv record does not name',
                    );
                  } else {
                    const idle = clockMs - Date.parse(stored.lastActivityAtIso);
                    if (idle < 0 || idle > PRACTICE_SET_IDLE_TIMEOUT_MS) {
                      violations.push(`resumed a set idle for ${idle}ms`);
                    }
                  }
                }
                pendingPlan = p;
              }
            } else if (settled.state === 'rejected') {
              outcome = `thrown:${(settled.error as Error).constructor.name}`;
            } else {
              outcome = 'pending_after_60s';
              violations.push('plan pending after 60s without a never fault');
            }
          } else if (which < 0.75) {
            op = 'note';
            const target = pick(rng, [
              liveStored().sessionId,
              ...sqlite.sessions.map(s => s.id),
            ]);
            const settled = await settle(
              notePracticeSetAnalysis(sqlite.db, target, scenario.nowIso),
            );
            outcome =
              settled.state === 'resolved'
                ? 'noted'
                : settled.state === 'rejected'
                  ? `thrown:${(settled.error as Error).constructor.name}`
                  : 'pending_after_60s';
            if (settled.state === 'pending')
              violations.push('note pending after 60s without a never fault');
            if (settled.state === 'resolved') {
              const stored = parseStored(
                sqlite.kv.get(practiceSetKeyForOwner(OWNER_A)),
              );
              if (
                !stored ||
                stored === 'invalid' ||
                stored.sessionId !== target ||
                stored.lastActivityAtIso !== scenario.nowIso
              ) {
                violations.push(
                  'note resolved but kv does not carry the noted session/time',
                );
              }
            }
          } else {
            op = 'current';
            const settled = await settle(
              currentPracticeSetId(sqlite.db, scenario.nowIso),
            );
            outcome =
              settled.state === 'resolved'
                ? settled.value === null
                  ? 'null'
                  : 'id'
                : settled.state === 'rejected'
                  ? `thrown:${(settled.error as Error).constructor.name}`
                  : 'pending_after_60s';
            if (settled.state === 'pending')
              violations.push(
                'current pending after 60s without a never fault',
              );
            if (settled.state === 'resolved' && settled.value !== null) {
              const stored = parseStored(
                sqlite.kv.get(practiceSetKeyForOwner(OWNER_A)),
              );
              if (
                !stored ||
                stored === 'invalid' ||
                stored.sessionId !== settled.value
              ) {
                violations.push(
                  'current returned an id the kv record does not name',
                );
              }
            }
          }
          if (
            (op === 'plan_fresh' || op === 'current') &&
            sqlite.writes !== writesBefore
          ) {
            violations.push(`${op} wrote to the database`);
          }
        }
        // Global invariants after every step.
        const newSessions = sqlite.sessions.length - sessionsBefore;
        const newCreates =
          sqlite.outbox.filter(x => x.kind === 'session.create').length -
          createsBefore;
        if (newSessions !== newCreates)
          violations.push(
            `local_session +${newSessions} but session.create +${newCreates}`,
          );
        if (sqlite.txnOpen)
          violations.push('transaction left open between steps');
        const stored = parseStored(
          sqlite.kv.get(practiceSetKeyForOwner(OWNER_A)),
        );
        if (stored === 'invalid') violations.push('kv holds an invalid record');
        for (const key of sqlite.kv.keys()) {
          if (key !== practiceSetKeyForOwner(OWNER_A))
            violations.push(`kv written under foreign key ${key}`);
        }
        steps.push({
          op,
          outcome: `${outcome} [${faultId}]`,
          violations,
          observations,
        });
      }
      const result: IterationResult = {
        seed,
        campaign: 'sitting',
        faults: faultIds,
        steps,
        kvAfter: snapshotKv(sqlite),
        sessions: sqlite.sessions.length,
        sessionCreates: sqlite.outbox.filter(r => r.kind === 'session.create')
          .length,
        txnOpen: sqlite.txnOpen,
        classification: classify(steps, sqlite),
      };
      results.push(result);
      expect(steps.flatMap(s => s.violations)).toEqual([]);
    },
  );
});

// ─── Pinned: the orphan a failed commit leaves behind ───────────────────────

describe('practiceSet failure injection — a failed first commit orphans the scored shot that already references the new set', () => {
  it('[BROKEN] saveSession rejects on commit → no session row / session.create; TRY AGAIN with the same id resumes it and never repairs the row (seed 70001)', async () => {
    const sqlite = new FakeSqlite([]);
    setActiveDataOwner(OWNER_A);
    const nowIso = new Date(T0).toISOString();
    const plan = await planPracticeSet(sqlite.db, {
      shotType: 'dink',
      nowIso,
      preferredSessionId: null,
    });
    expect(plan).not.toBeNull();
    expect(plan!.resumed).toBe(false);
    // AnalyzeScreen hands plan.sessionId to runCaptureAnalysis, which saves
    // the scored shot + its shot.sync outbox row in ITS OWN transaction. The
    // set is committed afterwards, in a second transaction:
    sqlite.faults.push({
      match: 'INSERT OR REPLACE INTO local_session',
      mode: 'reject',
    });
    await expect(commitPracticeSet(sqlite.db, plan!, nowIso)).rejects.toThrow(
      /SQLITE_BUSY/,
    );
    expect(sqlite.sessions).toHaveLength(0);
    expect(sqlite.outbox.filter(r => r.kind === 'session.create')).toHaveLength(
      0,
    );
    expect(sqlite.kv.size).toBe(0);
    expect(sqlite.txnOpen).toBe(false);

    // OBSERVED on 1fb0efd7: the player taps TRY AGAIN on that Result; the
    // rearm carries the orphan id as preferredSessionId. planPracticeSet
    // resolves it as `resumed: true` although nothing was ever stored, and a
    // (now healthy) commit therefore writes ONLY the kv stamp — the
    // local_session row and session.create outbox entry are never created.
    // Every shot.sync that references this id is answered with
    // `shot.session_not_found`, which sync.ts treats as TRANSIENT (attempt
    // budget never consumed): the durable local rating never reaches the
    // server and is retried on every drain, indefinitely.
    // EXPECTED: a preferred id with no local session row is committed as a
    // NEW set (session row + session.create written), or the scored shot and
    // its session row land in one transaction.
    sqlite.faults.splice(0, sqlite.faults.length);
    const rearm = await planPracticeSet(sqlite.db, {
      shotType: 'dink',
      nowIso,
      preferredSessionId: plan!.sessionId,
    });
    expect(rearm).toMatchObject({ sessionId: plan!.sessionId, resumed: true });
    await commitPracticeSet(sqlite.db, rearm!, nowIso);
    expect(
      parseStored(sqlite.kv.get(practiceSetKeyForOwner(OWNER_A))),
    ).toMatchObject({ sessionId: plan!.sessionId });
    expect(sqlite.sessions).toHaveLength(0);
    expect(sqlite.outbox.filter(r => r.kind === 'session.create')).toHaveLength(
      0,
    );
  });
});

// ─── Pinned: commit does not re-validate the owner it was planned for ───────

describe('practiceSet failure injection — commitPracticeSet trusts plan.owner for the kv stamp but the ACTIVE owner for the session row', () => {
  it('[OBSERVED] account switched between plan and commit → local_session/session.create under the new owner, kv stamp under the old one (seed 70002)', async () => {
    const sqlite = new FakeSqlite([]);
    setActiveDataOwner(OWNER_A);
    const nowIso = new Date(T0).toISOString();
    const plan = await planPracticeSet(sqlite.db, {
      shotType: 'dink',
      nowIso,
      preferredSessionId: null,
    });
    expect(plan).toMatchObject({ owner: OWNER_A, resumed: false });
    setActiveDataOwner(OWNER_B);
    await commitPracticeSet(sqlite.db, plan!, nowIso);
    // OBSERVED on 1fb0efd7: saveSession scopes by requireWritableDataOwner()
    // (B) while writeStoredSet scopes by plan.owner (A). B's account gets a
    // session it never started; A's live set names a session that does not
    // exist for A, so any shot A saved with this id syncs into
    // `shot.session_not_found` forever. EXPECTED: commitPracticeSet refuses
    // (throws) when the active owner differs from plan.owner.
    expect(sqlite.sessions).toEqual([
      expect.objectContaining({ owner: OWNER_B, id: plan!.sessionId }),
    ]);
    expect(sqlite.outbox.filter(r => r.kind === 'session.create')).toEqual([
      expect.objectContaining({ owner: OWNER_B }),
    ]);
    expect([...sqlite.kv.keys()]).toEqual([practiceSetKeyForOwner(OWNER_A)]);
  });

  it('[OBSERVED] signed out between plan and commit of a RESUMED set → kv stamp still written for the signed-out owner (seed 70003)', async () => {
    const sqlite = new FakeSqlite([]);
    setActiveDataOwner(OWNER_A);
    sqlite.kv.set(
      practiceSetKeyForOwner(OWNER_A),
      JSON.stringify(liveStored()),
    );
    const nowIso = new Date(T0).toISOString();
    const plan = await planPracticeSet(sqlite.db, {
      shotType: 'dink',
      nowIso,
      preferredSessionId: null,
    });
    expect(plan).toMatchObject({ owner: OWNER_A, resumed: true });
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await expect(
      commitPracticeSet(sqlite.db, plan!, nowIso),
    ).resolves.toBeUndefined();
    expect(sqlite.writes).toBe(1);
    expect(
      parseStored(sqlite.kv.get(practiceSetKeyForOwner(OWNER_A))),
    ).toMatchObject({ lastActivityAtIso: nowIso });
  });
});
