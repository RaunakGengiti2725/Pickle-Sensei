/**
 * Failure-injection catalog for the Progress screen stress harness.
 *
 * Pure data + a seeded PRNG so every iteration of the campaign is replayable
 * from `(seed)` alone. The harness (progressScreen.failureInjection.stress
 * .test.tsx) turns a `FaultPlan` into concrete behaviour at the two native
 * boundaries the screen bottoms out in — the op-sqlite module and
 * `globalThis.fetch` — plus the clock, the account session and the
 * navigation script that drives the mounted screen.
 *
 * Dependency coverage (what ProgressScreen actually reaches, INFERRED from
 * its import graph): SQLite (op-sqlite via data/db + data/repository, also
 * through the consistency + rank-celebration stores), fetch (/v1/progress
 * via progress/api, /v1/rank via PlayerRankCard), the in-memory API session
 * store, the clock (Date / Intl), and React Navigation (focus effects,
 * navigate, goBack). Keychain, camera, Vision, TTS, RevenueCat and
 * permissions are NOT imported by this screen; they are listed as
 * `not-reachable` so the report cannot mistake "not exercised" for "held".
 */

export type SqlTarget =
  | 'any'
  | 'facts'
  | 'captures'
  | 'kvRead'
  | 'kvWrite'
  | 'ledgerRead'
  | 'activity';

export type SqlBehavior =
  | { kind: 'reject'; message: string }
  | { kind: 'throwSync'; message: string }
  | { kind: 'never' }
  | { kind: 'slow'; delayMs: number }
  | { kind: 'nullResult' }
  | { kind: 'undefinedRows' }
  | { kind: 'objectRows' };

export interface SqlRule {
  target: SqlTarget;
  behavior: SqlBehavior;
  /** Matching calls to let through untouched before the behavior applies. */
  skip?: number;
  /** How many matching calls the behavior applies to (default: all). */
  remaining?: number;
}

export type OpenBehavior =
  | { kind: 'ok' }
  | { kind: 'throw'; remaining?: number }
  | { kind: 'migrationThrowAt'; statementIndex: number; remaining?: number };

export type FetchRoute = 'progress' | 'rank';

export type FetchBehavior =
  | { kind: 'ok' }
  | { kind: 'reject' }
  | { kind: 'throwSync' }
  | { kind: 'never' }
  | { kind: 'slow'; delayMs: number }
  | { kind: 'status'; status: number }
  | { kind: 'bodyNonJson' }
  | { kind: 'jsonNever' }
  | { kind: 'payload'; payload: unknown };

export type SessionMode =
  'none' | 'account' | 'malformedAccount' | 'clearMidFlight';

export type ClockMode =
  | 'now'
  | 'farFuture'
  | 'epoch'
  | 'jumpBackAfterLoad'
  | 'jumpForwardAfterLoad'
  | 'intlThrows';

export type Interaction =
  | 'switchPractice'
  | 'switchTechnique'
  | 'range7d'
  | 'range28d'
  | 'range90d'
  | 'openStreakCalendar'
  | 'goBack'
  | 'tabAway'
  | 'tabBack'
  | 'retryTwice'
  | 'unmountMidFlight';

export type FactsPayloadVariant =
  | 'valid'
  | 'nonJson'
  | 'wrongShape'
  | 'stringScores'
  | 'invalidDates'
  | 'futureDates'
  | 'missingColumn'
  | 'fixtureSource';

export type CapturesPayloadVariant =
  | 'valid'
  | 'nonJson'
  | 'metadataMismatch'
  | 'stringNumbers'
  | 'missingStatus'
  | 'legacyNull';

export type LedgerVariant =
  'valid' | 'truncated' | 'array' | 'number' | 'drillsGarbage';

export type RankRecordVariant = 'valid' | 'garbage' | 'wrongTypes';

export interface Fixture {
  factCount: number;
  captureCount: number;
  facts: FactsPayloadVariant;
  captures: CapturesPayloadVariant;
  ledger: LedgerVariant;
  ledgerDrillCount: number;
  rankRecord: RankRecordVariant;
  profileSkillLevel: string | null;
  spreadDays: number;
}

export interface FaultPlan {
  id: string;
  category:
    'sqlite' | 'fetch' | 'session' | 'clock' | 'navigation' | 'store' | 'combo';
  description: string;
  open: OpenBehavior;
  sql: SqlRule[];
  fetch: Partial<Record<FetchRoute, FetchBehavior>>;
  session: SessionMode;
  clock: ClockMode;
  interactions: Interaction[];
  fixture: Fixture;
  /**
   * What the screen is expected to do while the fault is live:
   *   'errorState'  – the local load cannot complete → retry UI required
   *   'dashboard'   – local evidence renders; the fault is tolerated by design
   *   'hung'        – lens-declared failure (local read never resolves)
   */
  expect: 'errorState' | 'dashboard' | 'hung';
  /** Whether the fault clears on its own (transient) — the retry must then
   * bring the dashboard back. */
  recoversOnRetry: boolean;
}

/** mulberry32 — small, fast, deterministic. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickOne<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length);
  const chosen = items[Math.min(index, items.length - 1)];
  if (chosen === undefined) throw new Error('pickOne on empty list');
  return chosen;
}

export function intBetween(rng: () => number, min: number, max: number) {
  return min + Math.floor(rng() * (max - min + 1));
}

export const HEALTHY_FIXTURE: Fixture = {
  factCount: 12,
  captureCount: 4,
  facts: 'valid',
  captures: 'valid',
  ledger: 'valid',
  ledgerDrillCount: 2,
  rankRecord: 'valid',
  profileSkillLevel: '3.5',
  spreadDays: 40,
};

const BASE: Omit<FaultPlan, 'id' | 'category' | 'description'> = {
  open: { kind: 'ok' },
  sql: [],
  fetch: {},
  session: 'account',
  clock: 'now',
  interactions: [],
  fixture: HEALTHY_FIXTURE,
  expect: 'dashboard',
  recoversOnRetry: false,
};

function plan(
  id: string,
  category: FaultPlan['category'],
  description: string,
  overrides: Partial<Omit<FaultPlan, 'id' | 'category' | 'description'>>,
): FaultPlan {
  return { ...BASE, id, category, description, ...overrides };
}

const ERR = 'SQLITE_BUSY: database is locked';

/** Canonical payload the healthy progress route returns. The checkpoint
 * name is unique so a render can prove account data reached the screen. */
export const CANONICAL_MARKER = 'canonical_marker_checkpoint';

export function healthyProgressPayload(day: string): unknown {
  return {
    series: [
      {
        day,
        shot_type: 'dink',
        scoring_model_version: 'srv-1',
        shot_count: 3,
        avg_score: 71,
        best_score: 82,
      },
    ],
    improving: [{ checkpoint: CANONICAL_MARKER, delta: 0.4 }],
    needsAttention: [],
    streak: {
      currentDays: 2,
      longestDays: 5,
      practicedToday: true,
      lastPracticeDate: day,
    },
  };
}

export function healthyRankPayload(): unknown {
  return {
    rating: 5.2,
    tier: 'silver',
    techniqueCount: 3,
    scoredShotCount: 12,
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

export const FAULT_CATALOG: readonly FaultPlan[] = [
  // ───────────── SQLite: open / migrate ─────────────
  plan('sqlite.open.throw', 'sqlite', 'op-sqlite open() throws', {
    open: { kind: 'throw' },
    expect: 'errorState',
  }),
  plan(
    'sqlite.open.throw.transient',
    'sqlite',
    'open() throws once, then succeeds on retry',
    {
      open: { kind: 'throw', remaining: 1 },
      expect: 'errorState',
      recoversOnRetry: true,
    },
  ),
  plan(
    'sqlite.migrate.throw.first',
    'sqlite',
    'first migration statement throws',
    {
      open: { kind: 'migrationThrowAt', statementIndex: 0 },
      expect: 'errorState',
    },
  ),
  plan(
    'sqlite.migrate.throw.mid',
    'sqlite',
    'a mid-list migration statement throws',
    {
      open: { kind: 'migrationThrowAt', statementIndex: 4 },
      expect: 'errorState',
    },
  ),
  plan(
    'sqlite.migrate.throw.transient',
    'sqlite',
    'migration throws once, then succeeds on retry',
    {
      open: { kind: 'migrationThrowAt', statementIndex: 2, remaining: 1 },
      expect: 'errorState',
      recoversOnRetry: true,
    },
  ),
  // ───────────── SQLite: reject ─────────────
  plan('sqlite.reject.any', 'sqlite', 'every execute() rejects', {
    sql: [{ target: 'any', behavior: { kind: 'reject', message: ERR } }],
    expect: 'errorState',
  }),
  plan('sqlite.reject.facts', 'sqlite', 'facts query rejects', {
    sql: [{ target: 'facts', behavior: { kind: 'reject', message: ERR } }],
    expect: 'errorState',
  }),
  plan('sqlite.reject.captures', 'sqlite', 'capture history query rejects', {
    sql: [{ target: 'captures', behavior: { kind: 'reject', message: ERR } }],
    expect: 'errorState',
  }),
  plan(
    'sqlite.reject.facts.transient1',
    'sqlite',
    'facts query rejects once, then succeeds',
    {
      sql: [
        {
          target: 'facts',
          behavior: { kind: 'reject', message: ERR },
          remaining: 1,
        },
      ],
      expect: 'errorState',
      recoversOnRetry: true,
    },
  ),
  plan(
    'sqlite.reject.captures.transient2',
    'sqlite',
    'capture query rejects twice, then succeeds',
    {
      sql: [
        {
          target: 'captures',
          behavior: { kind: 'reject', message: ERR },
          remaining: 2,
        },
      ],
      expect: 'errorState',
      recoversOnRetry: true,
      interactions: ['retryTwice'],
    },
  ),
  plan(
    'sqlite.reject.kvRead',
    'sqlite',
    'kv reads reject (consistency ledger + rank record unreadable)',
    { sql: [{ target: 'kvRead', behavior: { kind: 'reject', message: ERR } }] },
  ),
  plan('sqlite.reject.kvWrite', 'sqlite', 'kv writes reject', {
    sql: [
      {
        target: 'kvWrite',
        behavior: { kind: 'reject', message: 'SQLITE_READONLY' },
      },
    ],
  }),
  plan(
    'sqlite.reject.activity',
    'sqlite',
    'consistency activity query rejects while the main load succeeds',
    {
      sql: [{ target: 'activity', behavior: { kind: 'reject', message: ERR } }],
    },
  ),
  // ───────────── SQLite: sync throw ─────────────
  plan(
    'sqlite.throwSync.facts',
    'sqlite',
    'facts execute() throws synchronously',
    {
      sql: [{ target: 'facts', behavior: { kind: 'throwSync', message: ERR } }],
      expect: 'errorState',
    },
  ),
  plan(
    'sqlite.throwSync.captures',
    'sqlite',
    'captures execute() throws synchronously',
    {
      sql: [
        { target: 'captures', behavior: { kind: 'throwSync', message: ERR } },
      ],
      expect: 'errorState',
    },
  ),
  plan(
    'sqlite.throwSync.activity',
    'sqlite',
    'activity execute() throws synchronously',
    {
      sql: [
        { target: 'activity', behavior: { kind: 'throwSync', message: ERR } },
      ],
    },
  ),
  // ───────────── SQLite: never resolves ─────────────
  plan('sqlite.never.facts', 'sqlite', 'facts query never resolves', {
    sql: [{ target: 'facts', behavior: { kind: 'never' } }],
    expect: 'hung',
  }),
  plan('sqlite.never.captures', 'sqlite', 'captures query never resolves', {
    sql: [{ target: 'captures', behavior: { kind: 'never' } }],
    expect: 'hung',
  }),
  plan('sqlite.never.kvRead', 'sqlite', 'kv reads never resolve', {
    sql: [{ target: 'kvRead', behavior: { kind: 'never' } }],
  }),
  plan('sqlite.never.activity', 'sqlite', 'activity query never resolves', {
    sql: [{ target: 'activity', behavior: { kind: 'never' } }],
  }),
  plan('sqlite.never.kvWrite', 'sqlite', 'kv write never resolves', {
    sql: [{ target: 'kvWrite', behavior: { kind: 'never' } }],
  }),
  // ───────────── SQLite: slow ─────────────
  plan('sqlite.slow.facts.5s', 'sqlite', 'facts query takes 5s', {
    sql: [{ target: 'facts', behavior: { kind: 'slow', delayMs: 5_000 } }],
  }),
  plan('sqlite.slow.captures.20s', 'sqlite', 'captures query takes 20s', {
    sql: [{ target: 'captures', behavior: { kind: 'slow', delayMs: 20_000 } }],
  }),
  plan('sqlite.slow.any.45s', 'sqlite', 'every query takes 45s', {
    sql: [{ target: 'any', behavior: { kind: 'slow', delayMs: 45_000 } }],
  }),
  plan(
    'sqlite.slow.facts.59s',
    'sqlite',
    'facts query takes 59s (just inside the window)',
    {
      sql: [{ target: 'facts', behavior: { kind: 'slow', delayMs: 59_000 } }],
    },
  ),
  // ───────────── SQLite: malformed / partial results ─────────────
  plan('sqlite.result.null', 'sqlite', 'execute() resolves null', {
    sql: [{ target: 'facts', behavior: { kind: 'nullResult' } }],
    expect: 'errorState',
  }),
  plan(
    'sqlite.result.undefinedRows',
    'sqlite',
    'execute() resolves {rows: undefined}',
    {
      sql: [{ target: 'any', behavior: { kind: 'undefinedRows' } }],
    },
  ),
  plan(
    'sqlite.result.objectRows',
    'sqlite',
    'execute() resolves rows as a non-array object',
    {
      sql: [{ target: 'facts', behavior: { kind: 'objectRows' } }],
      expect: 'errorState',
    },
  ),
  plan(
    'sqlite.rows.facts.nonJson',
    'sqlite',
    'local_shot payloads are not JSON',
    {
      fixture: { ...HEALTHY_FIXTURE, facts: 'nonJson' },
    },
  ),
  plan(
    'sqlite.rows.facts.wrongShape',
    'sqlite',
    'local_shot payloads are JSON of the wrong shape',
    {
      fixture: { ...HEALTHY_FIXTURE, facts: 'wrongShape' },
    },
  ),
  plan(
    'sqlite.rows.facts.stringScores',
    'sqlite',
    'local_shot payload scores are strings/NaN',
    {
      fixture: { ...HEALTHY_FIXTURE, facts: 'stringScores' },
    },
  ),
  plan(
    'sqlite.rows.facts.invalidDates',
    'sqlite',
    'local_shot capturedAtIso values are garbage',
    {
      fixture: { ...HEALTHY_FIXTURE, facts: 'invalidDates' },
    },
  ),
  plan(
    'sqlite.rows.facts.futureDates',
    'sqlite',
    'local_shot rows are dated in the future',
    {
      fixture: { ...HEALTHY_FIXTURE, facts: 'futureDates' },
    },
  ),
  plan(
    'sqlite.rows.facts.missingColumn',
    'sqlite',
    'facts rows come back without the payload column',
    {
      fixture: { ...HEALTHY_FIXTURE, facts: 'missingColumn' },
    },
  ),
  plan(
    'sqlite.rows.facts.fixtureSource',
    'sqlite',
    'payload claims source=fixture',
    {
      fixture: { ...HEALTHY_FIXTURE, facts: 'fixtureSource' },
    },
  ),
  plan(
    'sqlite.rows.captures.nonJson',
    'sqlite',
    'capture payloads are not JSON',
    {
      fixture: { ...HEALTHY_FIXTURE, captures: 'nonJson' },
    },
  ),
  plan(
    'sqlite.rows.captures.mismatch',
    'sqlite',
    'capture payload metadata mismatches the row',
    {
      fixture: { ...HEALTHY_FIXTURE, captures: 'metadataMismatch' },
    },
  ),
  plan(
    'sqlite.rows.captures.stringNumbers',
    'sqlite',
    'capture numeric columns are strings',
    {
      fixture: { ...HEALTHY_FIXTURE, captures: 'stringNumbers' },
    },
  ),
  plan(
    'sqlite.rows.captures.missingStatus',
    'sqlite',
    'capture rows come back without status',
    {
      fixture: { ...HEALTHY_FIXTURE, captures: 'missingStatus' },
    },
  ),
  plan(
    'sqlite.rows.captures.legacyNull',
    'sqlite',
    'capture payloads are NULL (legacy rows)',
    {
      fixture: { ...HEALTHY_FIXTURE, captures: 'legacyNull' },
    },
  ),
  plan(
    'sqlite.rows.ledger.truncated',
    'sqlite',
    'consistency ledger kv is truncated JSON',
    {
      fixture: { ...HEALTHY_FIXTURE, ledger: 'truncated' },
    },
  ),
  plan(
    'sqlite.rows.ledger.array',
    'sqlite',
    'consistency ledger kv is a JSON array',
    {
      fixture: { ...HEALTHY_FIXTURE, ledger: 'array' },
    },
  ),
  plan(
    'sqlite.rows.ledger.number',
    'sqlite',
    'consistency ledger kv is a JSON number',
    {
      fixture: { ...HEALTHY_FIXTURE, ledger: 'number' },
    },
  ),
  plan(
    'sqlite.rows.ledger.drillsGarbage',
    'sqlite',
    'ledger drills array holds garbage entries',
    {
      fixture: { ...HEALTHY_FIXTURE, ledger: 'drillsGarbage' },
    },
  ),
  plan('sqlite.rows.rank.garbage', 'sqlite', 'rank celebration kv is garbage', {
    fixture: { ...HEALTHY_FIXTURE, rankRecord: 'garbage' },
  }),
  plan(
    'sqlite.rows.rank.wrongTypes',
    'sqlite',
    'rank celebration kv has wrong types',
    {
      fixture: { ...HEALTHY_FIXTURE, rankRecord: 'wrongTypes' },
    },
  ),
  plan('sqlite.rows.oversized', 'sqlite', '3000 facts + 600 captures', {
    fixture: {
      ...HEALTHY_FIXTURE,
      factCount: 3000,
      captureCount: 600,
      spreadDays: 400,
    },
  }),
  plan(
    'sqlite.kvRead.transient.ledgerClobber',
    'sqlite',
    'ledger read fails once while achievements are earned — durable drills must survive',
    {
      sql: [
        {
          target: 'kvRead',
          behavior: { kind: 'reject', message: ERR },
          remaining: 2,
        },
      ],
      fixture: {
        ...HEALTHY_FIXTURE,
        factCount: 30,
        ledgerDrillCount: 3,
        spreadDays: 6,
      },
    },
  ),
  // ───────────── fetch: /v1/progress ─────────────
  plan('fetch.progress.reject', 'fetch', '/v1/progress network error', {
    fetch: { progress: { kind: 'reject' } },
  }),
  plan(
    'fetch.progress.throwSync',
    'fetch',
    'fetch throws synchronously for /v1/progress',
    {
      fetch: { progress: { kind: 'throwSync' } },
    },
  ),
  plan(
    'fetch.progress.never',
    'fetch',
    '/v1/progress never responds (abort after 15s)',
    {
      fetch: { progress: { kind: 'never' } },
    },
  ),
  plan('fetch.progress.slow10s', 'fetch', '/v1/progress answers after 10s', {
    fetch: { progress: { kind: 'slow', delayMs: 10_000 } },
  }),
  plan(
    'fetch.progress.slow30s',
    'fetch',
    '/v1/progress answers after 30s (past the abort)',
    {
      fetch: { progress: { kind: 'slow', delayMs: 30_000 } },
    },
  ),
  plan('fetch.progress.500', 'fetch', '/v1/progress → 500', {
    fetch: { progress: { kind: 'status', status: 500 } },
  }),
  plan('fetch.progress.401', 'fetch', '/v1/progress → 401', {
    fetch: { progress: { kind: 'status', status: 401 } },
  }),
  plan('fetch.progress.429', 'fetch', '/v1/progress → 429', {
    fetch: { progress: { kind: 'status', status: 429 } },
  }),
  plan(
    'fetch.progress.bodyNonJson',
    'fetch',
    '/v1/progress 200 with a non-JSON body',
    {
      fetch: { progress: { kind: 'bodyNonJson' } },
    },
  ),
  plan(
    'fetch.progress.jsonNever',
    'fetch',
    '/v1/progress headers arrive, body never finishes',
    {
      fetch: { progress: { kind: 'jsonNever' } },
    },
  ),
  plan(
    'fetch.progress.malformed.shape',
    'fetch',
    '/v1/progress series is not an array',
    {
      fetch: {
        progress: {
          kind: 'payload',
          payload: {
            series: 'x',
            improving: [],
            needsAttention: [],
            streak: {},
          },
        },
      },
    },
  ),
  plan(
    'fetch.progress.partial.series',
    'fetch',
    '/v1/progress series rows miss fields',
    {
      fetch: {
        progress: {
          kind: 'payload',
          payload: {
            series: [{ day: '2026-09-01' }],
            improving: [],
            needsAttention: [],
            streak: {
              currentDays: 1,
              longestDays: 1,
              practicedToday: false,
              lastPracticeDate: null,
            },
          },
        },
      },
    },
  ),
  plan(
    'fetch.progress.partial.streak',
    'fetch',
    '/v1/progress streak has wrong types',
    {
      fetch: {
        progress: {
          kind: 'payload',
          payload: {
            series: [],
            improving: [],
            needsAttention: [],
            streak: { currentDays: 'two' },
          },
        },
      },
    },
  ),
  plan(
    'fetch.progress.nan',
    'fetch',
    '/v1/progress numbers are NaN-ish strings',
    {
      fetch: {
        progress: {
          kind: 'payload',
          payload: {
            series: [
              {
                day: '2026-09-01',
                shot_type: 'dink',
                scoring_model_version: 'v',
                shot_count: 'abc',
                avg_score: 'NaN',
                best_score: null,
              },
            ],
            improving: [{ checkpoint: CANONICAL_MARKER, delta: 'x' }],
            needsAttention: [],
            streak: {
              currentDays: 1,
              longestDays: 1,
              practicedToday: true,
              lastPracticeDate: null,
            },
          },
        },
      },
    },
  ),
  plan('fetch.progress.null', 'fetch', '/v1/progress body is JSON null', {
    fetch: { progress: { kind: 'payload', payload: null } },
  }),
  plan('fetch.progress.array', 'fetch', '/v1/progress body is a JSON array', {
    fetch: { progress: { kind: 'payload', payload: [] } },
  }),
  // ───────────── fetch: /v1/rank ─────────────
  plan('fetch.rank.reject', 'fetch', '/v1/rank network error', {
    fetch: { rank: { kind: 'reject' } },
  }),
  plan(
    'fetch.rank.throwSync',
    'fetch',
    'fetch throws synchronously for /v1/rank',
    {
      fetch: { rank: { kind: 'throwSync' } },
    },
  ),
  plan('fetch.rank.never', 'fetch', '/v1/rank never responds', {
    fetch: { rank: { kind: 'never' } },
  }),
  plan('fetch.rank.slow20s', 'fetch', '/v1/rank answers after 20s', {
    fetch: { rank: { kind: 'slow', delayMs: 20_000 } },
  }),
  plan('fetch.rank.500', 'fetch', '/v1/rank → 500', {
    fetch: { rank: { kind: 'status', status: 500 } },
  }),
  plan('fetch.rank.403', 'fetch', '/v1/rank → 403', {
    fetch: { rank: { kind: 'status', status: 403 } },
  }),
  plan('fetch.rank.bodyNonJson', 'fetch', '/v1/rank 200 with a non-JSON body', {
    fetch: { rank: { kind: 'bodyNonJson' } },
  }),
  plan('fetch.rank.jsonNever', 'fetch', '/v1/rank body never finishes', {
    fetch: { rank: { kind: 'jsonNever' } },
  }),
  plan('fetch.rank.malformed', 'fetch', '/v1/rank payload has wrong types', {
    fetch: { rank: { kind: 'payload', payload: { rating: 'high', tier: 42 } } },
  }),
  plan('fetch.rank.partial', 'fetch', '/v1/rank payload misses fields', {
    fetch: { rank: { kind: 'payload', payload: { rating: 5.1 } } },
  }),
  plan(
    'fetch.rank.outOfRange',
    'fetch',
    '/v1/rank rating is out of range / tier unknown',
    {
      fetch: {
        rank: {
          kind: 'payload',
          payload: {
            rating: 99,
            tier: 'diamond-plus',
            techniqueCount: -1,
            scoredShotCount: 1e9,
          },
        },
      },
    },
  ),
  plan('fetch.both.reject', 'fetch', 'both account routes fail', {
    fetch: { progress: { kind: 'reject' }, rank: { kind: 'reject' } },
  }),
  plan('fetch.both.never', 'fetch', 'both account routes hang', {
    fetch: { progress: { kind: 'never' }, rank: { kind: 'never' } },
  }),
  // ───────────── session ─────────────
  plan('session.none', 'session', 'no API session (local-only owner)', {
    session: 'none',
  }),
  plan(
    'session.malformed',
    'session',
    'API session has an unusable base URL / empty bearer',
    {
      session: 'malformedAccount',
      fetch: { progress: { kind: 'reject' }, rank: { kind: 'reject' } },
    },
  ),
  plan(
    'session.clearMidFlight',
    'session',
    'session is cleared while the load is in flight',
    {
      session: 'clearMidFlight',
      fetch: {
        progress: { kind: 'slow', delayMs: 3_000 },
        rank: { kind: 'slow', delayMs: 3_000 },
      },
    },
  ),
  // ───────────── clock ─────────────
  plan('clock.farFuture', 'clock', 'device clock is in 2099', {
    clock: 'farFuture',
  }),
  plan('clock.epoch', 'clock', 'device clock is at the epoch', {
    clock: 'epoch',
  }),
  plan('clock.jumpBack', 'clock', 'clock jumps back 30 days after the load', {
    clock: 'jumpBackAfterLoad',
    interactions: ['switchPractice', 'switchTechnique'],
  }),
  plan(
    'clock.jumpForward',
    'clock',
    'clock jumps forward 400 days after the load',
    {
      clock: 'jumpForwardAfterLoad',
      interactions: ['range90d'],
    },
  ),
  plan(
    'clock.intlThrows',
    'clock',
    'Intl.DateTimeFormat() with no arguments throws',
    {
      clock: 'intlThrows',
    },
  ),
  // ───────────── navigation ─────────────
  plan(
    'nav.unmountMidFlight.slowFacts',
    'navigation',
    'screen unmounts while facts are in flight',
    {
      sql: [{ target: 'facts', behavior: { kind: 'slow', delayMs: 4_000 } }],
      interactions: ['unmountMidFlight'],
    },
  ),
  plan(
    'nav.tabAway.duringSlowLoad',
    'navigation',
    'tab away + back during a slow load',
    {
      sql: [{ target: 'any', behavior: { kind: 'slow', delayMs: 2_000 } }],
      interactions: ['tabAway', 'tabBack'],
    },
  ),
  plan(
    'nav.calendar.roundtrip.underFault',
    'navigation',
    'open streak calendar and return while kv reads reject',
    {
      sql: [{ target: 'kvRead', behavior: { kind: 'reject', message: ERR } }],
      interactions: ['openStreakCalendar', 'goBack'],
    },
  ),
  plan(
    'nav.calendar.roundtrip.refocusFails',
    'navigation',
    'return from the calendar into a failing facts read',
    {
      sql: [
        {
          target: 'facts',
          behavior: { kind: 'reject', message: ERR },
          skip: 1,
        },
      ],
      interactions: ['openStreakCalendar', 'goBack'],
    },
  ),
  plan(
    'nav.retry.double',
    'navigation',
    'double-tapped retry under a transient fault',
    {
      sql: [
        {
          target: 'facts',
          behavior: { kind: 'reject', message: ERR },
          remaining: 1,
        },
      ],
      expect: 'errorState',
      recoversOnRetry: true,
      interactions: ['retryTwice'],
    },
  ),
  plan(
    'nav.sections.underFetchFault',
    'navigation',
    'switch sections and ranges while account routes fail',
    {
      fetch: {
        progress: { kind: 'status', status: 500 },
        rank: { kind: 'reject' },
      },
      interactions: [
        'switchPractice',
        'range7d',
        'range90d',
        'switchTechnique',
        'range28d',
      ],
    },
  ),
  // ───────────── store ─────────────
  plan(
    'store.profile.garbageSkill',
    'store',
    'profile skill level is garbage',
    {
      fixture: { ...HEALTHY_FIXTURE, profileSkillLevel: '<<garbage-level>>' },
    },
  ),
  plan('store.profile.null', 'store', 'no profile in the app store', {
    fixture: { ...HEALTHY_FIXTURE, profileSkillLevel: null },
  }),
  plan(
    'store.empty',
    'store',
    'fresh account: no facts, captures, ledger or rank record',
    {
      fixture: {
        ...HEALTHY_FIXTURE,
        factCount: 0,
        captureCount: 0,
        ledgerDrillCount: 0,
      },
    },
  ),
  // ───────────── combos ─────────────
  plan(
    'combo.kvReject+fetchReject',
    'combo',
    'kv reads reject and account routes fail',
    {
      sql: [{ target: 'kvRead', behavior: { kind: 'reject', message: ERR } }],
      fetch: { progress: { kind: 'reject' }, rank: { kind: 'reject' } },
    },
  ),
  plan(
    'combo.slowFacts+progressNever',
    'combo',
    'slow facts and hanging progress route',
    {
      sql: [{ target: 'facts', behavior: { kind: 'slow', delayMs: 8_000 } }],
      fetch: { progress: { kind: 'never' } },
    },
  ),
  plan(
    'combo.transientFacts+rank500+farFuture',
    'combo',
    'transient facts fault, rank 500, clock 2099',
    {
      sql: [
        {
          target: 'facts',
          behavior: { kind: 'reject', message: ERR },
          remaining: 1,
        },
      ],
      fetch: { rank: { kind: 'status', status: 500 } },
      clock: 'farFuture',
      expect: 'errorState',
      recoversOnRetry: true,
    },
  ),
  plan(
    'combo.malformedRows+malformedProgress',
    'combo',
    'garbage local rows and garbage account payload',
    {
      fixture: {
        ...HEALTHY_FIXTURE,
        facts: 'stringScores',
        captures: 'stringNumbers',
        ledger: 'array',
      },
      fetch: {
        progress: {
          kind: 'payload',
          payload: {
            series: [{}],
            improving: [{}],
            needsAttention: [{}],
            streak: {},
          },
        },
      },
    },
  ),
];

export const NOT_REACHABLE_DEPENDENCIES = [
  'react-native-keychain (sessionVault) — not imported by ProgressScreen',
  'camera / Vision provider — AnalyzeScreen only',
  'TTS / audio coach — not imported by ProgressScreen',
  'RevenueCat / billing — accessStore only, not read by ProgressScreen',
  'permissions — no permission request on the Progress tab',
] as const;

/**
 * Random campaign: a seed picks one catalog fault and perturbs the fixture
 * and interaction script around it, so the same fault meets many data
 * shapes and drive orders. Replay with the seed alone.
 */
export function planFromSeed(seed: number): FaultPlan {
  const rng = makeRng(seed);
  const base = pickOne(rng, FAULT_CATALOG);
  const factsVariant = pickOne<FactsPayloadVariant>(rng, [
    'valid',
    'valid',
    'valid',
    'nonJson',
    'wrongShape',
    'stringScores',
    'invalidDates',
    'futureDates',
  ]);
  const capturesVariant = pickOne<CapturesPayloadVariant>(rng, [
    'valid',
    'valid',
    'nonJson',
    'metadataMismatch',
    'stringNumbers',
    'legacyNull',
  ]);
  const fixture: Fixture = {
    factCount: intBetween(rng, 0, 60),
    captureCount: intBetween(rng, 0, 12),
    facts: base.fixture.facts === 'valid' ? factsVariant : base.fixture.facts,
    captures:
      base.fixture.captures === 'valid'
        ? capturesVariant
        : base.fixture.captures,
    ledger: base.fixture.ledger,
    ledgerDrillCount: intBetween(rng, 0, 4),
    rankRecord: base.fixture.rankRecord,
    profileSkillLevel: pickOne(rng, ['3.5', '4.0', null, '2.5']),
    spreadDays: intBetween(rng, 1, 120),
  };
  const interactionPool: Interaction[] = [
    'switchPractice',
    'switchTechnique',
    'range7d',
    'range28d',
    'range90d',
    'openStreakCalendar',
    'goBack',
    'tabAway',
    'tabBack',
  ];
  const extra: Interaction[] = [];
  const count = intBetween(rng, 0, 4);
  for (let i = 0; i < count; i += 1) extra.push(pickOne(rng, interactionPool));
  const session: SessionMode =
    base.session === 'account'
      ? pickOne(rng, ['account', 'account', 'none'])
      : base.session;
  return {
    ...base,
    id: `${base.id}#${seed}`,
    fixture: base.id === 'sqlite.rows.oversized' ? base.fixture : fixture,
    interactions: [...base.interactions, ...extra],
    session,
  };
}
