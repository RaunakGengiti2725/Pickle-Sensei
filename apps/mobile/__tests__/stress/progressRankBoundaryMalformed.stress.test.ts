/**
 * STRESS — progress/rank module × BOUNDARY / MALFORMED INPUT lens.
 *
 * Seeded, replayable campaign over `src/progress/{playerRank, rankCelebration,
 * gameplayProgression, duprEstimate, techniqueDashboard}.ts`: malformed and
 * truncated JSON, wrong types, prototype-pollution keys, NaN / ±Infinity / -0 /
 * overflow, null bytes, 64 KB+ strings (bytes vs code points vs graphemes),
 * path traversal in ids, future schema versions, empty and huge histories,
 * NFC/NFD pairs, invalid time zones and instants, plus fault-injected
 * persistence for the celebration store.
 *
 * Scale:   STRESS_ITER=<n>      seeds (default 80 → 7 probes each, 560
 *                              scenarios, a few seconds of CPU)
 * Replay:  STRESS_ONLY=<seed>   run one seed across every module
 *          STRESS_MODULE=<m>    restrict to one module
 * Output:  STRESS_OUT=<dir>     JSON table seed → outcome
 *                              (default apps/mobile/artifacts/stress, gitignored)
 *
 * Campaign: STRESS_ITER=3000 npx jest --ci --silent progressRankBoundaryMalformed
 *
 * Outcomes: HELD (accepted, every hard invariant held) · REJECTED_TYPED (the
 * documented typed error) · BROKEN (untyped throw, non-finite output, oracle
 * mismatch, prototype write). The suite fails on any BROKEN scenario and
 * prints the seed with its replay command. Documented spec deviations that
 * are not crashes are counted separately (`specNotes`) and pinned below with
 * `test.failing` — fixing one flips its pin, which is the intended signal.
 */
import {
  playerRankDivisionForRating,
  type PlayerRankSummary,
} from '@pickle/shared-types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  describeInput,
  mulberry32,
  prototypeIntegrityViolations,
  runScenario,
  STRESS_MODULES,
  type ScenarioResult,
  type StressModule,
} from '../../test-support/stress/progressRankBoundaryHarness';

// In-memory kv with fault injection for the celebration store. The mock must
// be declared before the store module is imported.
const mockKvTable = new Map<string, string>();
const mockKvFaults = { readThrows: false, writeThrows: false };
const mockKvState = { writes: 0 };
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockKvFaults.readThrows) throw new Error('SQLITE_IOERR: read');
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockKvFaults.writeThrows) throw new Error('SQLITE_FULL: write');
        mockKvState.writes += 1;
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

import {
  duprEstimate,
  formatDuprEstimate,
} from '../../src/progress/duprEstimate';
import {
  parsePlayerRank,
  PlayerRankApiError,
  resolvePlayerRank,
  summaryFromServer,
} from '../../src/progress/playerRank';
import {
  rankCelebrationKeyForOwner,
  tierIndex,
  useRankCelebrationStore,
} from '../../src/progress/rankCelebration';
import { buildGameplayProgression } from '../../src/progress/gameplayProgression';
import { buildTechniqueDashboard } from '../../src/progress/techniqueDashboard';
import type { RealAnalysisFact } from '../../src/data/repository';

// Node built-ins for the raw artifacts; the mobile tsconfig excludes node
// typings (same shim the matrix suites use).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const ITER = Number(process.env.STRESS_ITER ?? 80);
const ONLY = process.env.STRESS_ONLY ? Number(process.env.STRESS_ONLY) : null;
const MODULE_FILTER = process.env.STRESS_MODULE ?? null;
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');
const SEEDS: number[] =
  ONLY !== null
    ? [ONLY]
    : Array.from({ length: ITER }, (_ignored, index) => index + 1);

if (!Number.isInteger(ITER) || ITER < 1) {
  throw new Error(
    `STRESS_ITER must be a positive integer, got ${String(process.env.STRESS_ITER)}`,
  );
}
if (ONLY !== null && !Number.isInteger(ONLY)) {
  throw new Error(
    `STRESS_ONLY must be an integer seed, got ${String(process.env.STRESS_ONLY)}`,
  );
}

// Huge-history probes cost ~30 ms per seed; scale the per-test budget.
jest.setTimeout(Math.max(5_000, SEEDS.length * 100));

const results: ScenarioResult[] = [];
const wallStart = Date.now();

function replayCommand(seed: number, module: string): string {
  return `cd apps/mobile && STRESS_ONLY=${seed} STRESS_MODULE=${module} npx jest --ci progressRankBoundaryMalformed`;
}

function reportBroken(module: string, rows: ScenarioResult[]): void {
  const broken = rows.filter(row => row.outcome === 'BROKEN');
  if (broken.length === 0) return;
  const lines = broken
    .slice(0, 10)
    .map(
      row =>
        `seed ${row.seed} [${row.family}]\n    ${row.violations.join('\n    ')}\n    input: ${row.input}\n    replay: ${replayCommand(row.seed, module)}`,
    );
  throw new Error(
    `${module}: ${broken.length}/${rows.length} scenarios BROKEN\n  ${lines.join('\n  ')}`,
  );
}

async function campaign(module: StressModule): Promise<ScenarioResult[]> {
  const rows: ScenarioResult[] = [];
  for (const seed of SEEDS) rows.push(await runScenario(seed, module));
  results.push(...rows);
  return rows;
}

const modules = STRESS_MODULES.filter(
  module => MODULE_FILTER === null || module === MODULE_FILTER,
);
if (modules.length === 0 && MODULE_FILTER !== 'rankCelebrationStore') {
  throw new Error(
    `STRESS_MODULE must be one of ${STRESS_MODULES.join(', ')}, rankCelebrationStore`,
  );
}

describe('progress/rank boundary + malformed input campaign', () => {
  for (const module of modules) {
    it(`${module}: never an untyped throw, never a prototype write, every output well-formed (${SEEDS.length} seeds)`, async () => {
      reportBroken(module, await campaign(module));
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// rankCelebration store: fuzzed persisted records + fault-injected kv.
// Lives here because the db mock must be module-scoped.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER = '44444444-4444-4444-8444-444444444444';
const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond'] as const;

function summaryFor(tier: string, rating: number): PlayerRankSummary {
  const { division, label: divisionLabel } =
    playerRankDivisionForRating(rating);
  return {
    rating,
    tier: tier as PlayerRankSummary['tier'],
    tierLabel: tier,
    division,
    divisionLabel,
    techniqueCount: 1,
    scoredAnalysisCount: 1,
    techniques: [],
    nextTier: null,
  };
}

const STORED_RAW: readonly (string | null)[] = [
  null,
  '',
  ' ',
  '{',
  '[]',
  '[{"tier":"gold","rating":6}]',
  'null',
  '1',
  '"gold"',
  '{"tier":"gold"}',
  '{"rating":6}',
  '{"tier":"gold","rating":"6"}',
  '{"tier":"gold","rating":null}',
  '{"tier":"GOLD","rating":6}',
  '{"tier":"gold\\u0000","rating":6}',
  '{"tier":"grandmaster","rating":6}',
  '{"tier":"gold","rating":6,"version":99}',
  '{"tier":"gold","rating":6,"version":"1"}',
  '{"__proto__":{"tier":"diamond","rating":9},"tier":"bronze","rating":1}',
  '{"constructor":{"prototype":{"tier":"diamond"}},"tier":"gold","rating":6}',
  '{"tier":"gold","rating":1e400}',
  '{"tier":"gold","rating":-0}',
  '{"tier":"gold","rating":6.000000000000001}',
  `{"tier":"gold","rating":6,"pad":"${'x'.repeat(70_000)}"}`,
  '{"tier":"gold","rating":6}\u0000',
  '{"tier":"../../etc/passwd","rating":6}',
];

function parseStoredOracle(
  raw: string | null,
): { tier: string; rating: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record['tier'] !== 'string' || tierIndex(record['tier']) < 0)
      return null;
    if (
      typeof record['rating'] !== 'number' ||
      !Number.isFinite(record['rating'])
    )
      return null;
    return { tier: record['tier'], rating: record['rating'] };
  } catch {
    return null;
  }
}

interface StoreScenario {
  seed: number;
  stored: string | null;
  storedFamily: string;
  tier: string;
  rating: number;
  fault: 'none' | 'read' | 'write';
  signedOut: boolean;
}

function storeScenario(seed: number): StoreScenario {
  const rng = mulberry32((seed * 2654435761) >>> 0);
  const roll = rng();
  let stored: string | null;
  let storedFamily: string;
  if (roll < 0.5) {
    stored = STORED_RAW[Math.floor(rng() * STORED_RAW.length)] ?? null;
    storedFamily = 'raw-corpus';
  } else if (roll < 0.8) {
    const tier = TIERS[Math.floor(rng() * TIERS.length)]!;
    stored = JSON.stringify({
      version: 1,
      tier,
      rating: Math.round(rng() * 1000) / 100,
    });
    storedFamily = 'valid-record';
  } else {
    // Truncated valid record.
    const text = JSON.stringify({ version: 1, tier: 'gold', rating: 6.5 });
    stored = text.slice(0, Math.floor(rng() * text.length));
    storedFamily = 'truncated';
  }
  const faultRoll = rng();
  return {
    seed,
    stored,
    storedFamily,
    tier: TIERS[Math.floor(rng() * TIERS.length)]!,
    rating: Math.round(rng() * 1000) / 100,
    fault: faultRoll < 0.8 ? 'none' : faultRoll < 0.9 ? 'read' : 'write',
    signedOut: rng() < 0.1,
  };
}

async function runStoreScenario(
  scenario: StoreScenario,
): Promise<ScenarioResult> {
  const started = Date.now();
  const violations: string[] = [];
  mockKvTable.clear();
  mockKvState.writes = 0;
  mockKvFaults.readThrows = scenario.fault === 'read';
  mockKvFaults.writeThrows = scenario.fault === 'write';
  useRankCelebrationStore.setState({ current: null, pending: null });
  setActiveDataOwner(scenario.signedOut ? SIGNED_OUT_DATA_OWNER : OWNER);
  const key = rankCelebrationKeyForOwner(OWNER);
  if (scenario.stored !== null) mockKvTable.set(key, scenario.stored);
  const summary = summaryFor(scenario.tier, scenario.rating);
  const before = parseStoredOracle(scenario.stored);
  try {
    await useRankCelebrationStore.getState().maybeCelebrate(summary);
  } catch (error) {
    violations.push(
      `maybeCelebrate rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { current, pending } = useRankCelebrationStore.getState();
  if (pending !== null)
    violations.push('pending set without a visible walkthrough');
  const after = mockKvTable.get(key);
  if (scenario.signedOut || scenario.fault !== 'none') {
    if (mockKvState.writes !== 0)
      violations.push(
        `wrote kv during ${scenario.signedOut ? 'signed-out' : scenario.fault}-fault scenario`,
      );
    if (current !== null)
      violations.push(
        'celebrated although the record could not be read/persisted',
      );
    if (scenario.fault === 'none' && after !== (scenario.stored ?? undefined))
      violations.push('signed-out run altered kv');
  } else {
    const expectedRecord = JSON.stringify({
      version: 1,
      tier: scenario.tier,
      rating: scenario.rating,
    });
    const unchanged =
      before !== null &&
      before.tier === scenario.tier &&
      before.rating === scenario.rating;
    if (unchanged) {
      if (mockKvState.writes !== 0)
        violations.push('rewrote an identical record');
    } else if (after !== expectedRecord) {
      violations.push(
        `kv holds ${describeInput(after, 80)} instead of the canonical record`,
      );
    } else if (mockKvState.writes !== 1) {
      violations.push(`expected exactly one write, saw ${mockKvState.writes}`);
    }
    const shouldCelebrate =
      before === null || tierIndex(scenario.tier) > tierIndex(before.tier);
    if (shouldCelebrate && current === null)
      violations.push('upward/placement move produced no celebration');
    if (!shouldCelebrate && current !== null)
      violations.push('sideways/downward move celebrated');
    if (current) {
      if (current.toTier !== scenario.tier)
        violations.push('celebration toTier mismatch');
      if (before === null && current.fromTier !== null)
        violations.push('placement carries fromTier');
      if (before !== null && current.fromTier !== before.tier)
        violations.push('promotion fromTier mismatch');
    }
    // Second report of the same summary must be idempotent: no write, no ceremony.
    useRankCelebrationStore.setState({ current: null, pending: null });
    const writesBefore = mockKvState.writes;
    await useRankCelebrationStore.getState().maybeCelebrate(summary);
    if (mockKvState.writes !== writesBefore)
      violations.push('idempotent re-report wrote kv again');
    if (useRankCelebrationStore.getState().current !== null)
      violations.push('idempotent re-report celebrated again');
  }
  violations.push(...prototypeIntegrityViolations());
  return {
    seed: scenario.seed,
    module: 'rankCelebrationStore' as unknown as StressModule,
    family: `${scenario.storedFamily};fault=${scenario.fault};${scenario.signedOut ? 'signed-out' : 'signed-in'}`,
    outcome: violations.length ? 'BROKEN' : 'HELD',
    violations,
    specNotes: [],
    input: describeInput({
      stored: scenario.stored,
      tier: scenario.tier,
      rating: scenario.rating,
    }),
    ms: Date.now() - started,
  };
}

describe('rankCelebration store × corrupt persisted record × kv faults', () => {
  afterEach(() => {
    mockKvFaults.readThrows = false;
    mockKvFaults.writeThrows = false;
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    useRankCelebrationStore.setState({ current: null, pending: null });
  });

  const enabled =
    MODULE_FILTER === null || MODULE_FILTER === 'rankCelebrationStore';
  (enabled ? it : it.skip)(
    `never rejects, never writes on fault/signed-out, always leaves a canonical record (${SEEDS.length} seeds)`,
    async () => {
      const rows: ScenarioResult[] = [];
      for (const seed of SEEDS)
        rows.push(await runStoreScenario(storeScenario(seed)));
      results.push(...rows);
      reportBroken('rankCelebrationStore', rows);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic boundary corpus — the exact edges the generators sample from,
// pinned individually so a regression names the edge.
// ─────────────────────────────────────────────────────────────────────────────

describe('deterministic boundary corpus', () => {
  it('duprEstimate clamps every finite boundary onto 1.0–7.0 and formats one decimal', () => {
    for (const score of [
      0,
      -0,
      10,
      -1e308,
      1e308,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      5e-324,
      9.999999,
      10.0000001,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const estimate = duprEstimate(score);
      expect(Number.isFinite(estimate)).toBe(true);
      expect(estimate).toBeGreaterThanOrEqual(1);
      expect(estimate).toBeLessThanOrEqual(7);
      expect(formatDuprEstimate(score)).toMatch(/^\(≈ DUPR \d\.\d\)$/);
    }
    expect(duprEstimate(-0)).toBe(1);
    expect(Object.is(duprEstimate(-0), -0)).toBe(false);
  });

  it('parsePlayerRank never lets a prototype-pollution payload write to Object.prototype', () => {
    const payload = JSON.parse(
      '{"__proto__":{"polluted":true},"rank":{"__proto__":{"polluted":true},"rating":5,"tier":"gold","techniqueCount":1,"techniques":[{"__proto__":{"polluted":true},"shot_type":"dink","score":5,"captured_at":"2026-08-01T00:00:00.000Z"}]}}',
    ) as unknown;
    const rank = parsePlayerRank(payload);
    expect(rank?.rating).toBe(5);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(prototypeIntegrityViolations()).toEqual([]);
  });

  it('parsePlayerRank accepts 64 KB / 30k-code-point / 4k-grapheme tier strings and re-derives the tier', () => {
    for (const tier of [
      'A'.repeat(65_536),
      'é'.repeat(30_000),
      '👨‍👩‍👧‍👦'.repeat(4_000),
      'e\u0301',
      '\u00e9',
      'gold\u0000',
      '../../gold',
    ]) {
      const rank = parsePlayerRank({
        rank: {
          rating: 6,
          tier,
          techniqueCount: 1,
          scoredShotCount: 3,
          updatedAt: null,
          techniques: [
            {
              shot_type: 'dink',
              score: 6,
              captured_at: '2026-08-01T00:00:00.000Z',
            },
          ],
        },
      });
      expect(rank).not.toBeNull();
      const summary = summaryFromServer(rank!);
      expect(summary.tier).toBe('gold');
      expect(summary.tierLabel).toBe('Gold');
    }
  });

  it('resolvePlayerRank tolerates an empty history, a null server and a 5 000-row history', () => {
    expect(resolvePlayerRank([], null)).toBeNull();
    const facts = Array.from({ length: 5_000 }, (_ignored, index) => ({
      id: `id-${index}`,
      shotType: index % 2 ? 'dink' : 'serve',
      capturedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      overallScore: (index % 101) / 10,
      resultKind: 'scored',
    }));
    const resolved = resolvePlayerRank(facts, null);
    expect(resolved?.source).toBe('device');
    expect(resolved?.summary.scoredAnalysisCount).toBe(5_000);
    expect(resolved?.summary.techniqueCount).toBe(2);
  });

  it('buildTechniqueDashboard rejects each invalid option with its typed message and keeps 13 bars for 90d', () => {
    const facts: RealAnalysisFact[] = [];
    expect(() =>
      buildTechniqueDashboard(facts, {
        asOfIso: '2026-08-01T00:00:00.000Z',
        timeZone: 'UTC',
        range: '1d' as never,
      }),
    ).toThrow('Unsupported technique dashboard range.');
    expect(() =>
      buildTechniqueDashboard(facts, {
        asOfIso: 'not a date',
        timeZone: 'UTC',
        range: '7d',
      }),
    ).toThrow('asOfIso must be a parseable ISO timestamp.');
    expect(() =>
      buildTechniqueDashboard(facts, {
        asOfIso: '+275760-09-13T00:00:00.001Z',
        timeZone: 'UTC',
        range: '7d',
      }),
    ).toThrow('asOfIso must be a parseable ISO timestamp.');
    expect(() =>
      buildTechniqueDashboard(facts, {
        asOfIso: '2026-08-01T00:00:00.000Z',
        timeZone: '../../etc/localtime',
        range: '7d',
      }),
    ).toThrow('timeZone must be a supported IANA timezone.');
    for (const timeZone of [
      'Pacific/Kiritimati',
      'Etc/GMT+12',
      'Asia/Kathmandu',
      'Australia/Lord_Howe',
    ]) {
      for (const asOfIso of [
        '2026-08-01T23:59:59.999Z',
        '1970-01-02T12:00:00.000Z',
        '9999-12-30T12:00:00.000Z',
        '1000-01-02T12:00:00.000Z',
      ]) {
        const dashboard = buildTechniqueDashboard(facts, {
          asOfIso,
          timeZone,
          range: '90d',
        });
        expect(dashboard.buckets.length).toBeLessThanOrEqual(13);
        expect(dashboard.buckets.length).toBeGreaterThan(0);
        expect(
          dashboard.buckets.reduce((sum, bucket) => sum + bucket.count, 0),
        ).toBe(0);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Minimized reproductions of the spec deviations the campaign surfaced
// (`specNotes` S1–S5). Each block asserts the EXPECTED behaviour under
// `test.failing`, so it passes while the deviation exists and flips to a
// failure the moment production is fixed — the signal to promote it to a
// regular test. Inputs are the minimized seeds from the campaign table.
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_RANK_BASE = {
  tier: 'gold',
  techniqueCount: 1,
  updatedAt: null,
  techniques: [
    { shot_type: 'dink', score: 6, captured_at: '2026-08-01T00:00:00.000Z' },
  ],
};

describe('spec deviations (pinned inverted — flip when fixed)', () => {
  test.failing(
    'S1: scoredShotCount:null from the edge fallback path must stay null so the summary falls back to techniques.length',
    () => {
      const rank = parsePlayerRank({
        rank: { ...SERVER_RANK_BASE, rating: 6, scoredShotCount: null },
      });
      expect(rank?.scoredShotCount).toBeNull();
      expect(summaryFromServer(rank!).scoredAnalysisCount).toBe(1);
    },
  );

  test.failing(
    'S1b: with a null server count and one local scored fact the account summary must win the tie',
    () => {
      const rank = parsePlayerRank({
        rank: { ...SERVER_RANK_BASE, rating: 6, scoredShotCount: null },
      });
      const resolved = resolvePlayerRank(
        [
          {
            id: 'a',
            shotType: 'dink',
            capturedAt: '2026-08-01T00:00:00.000Z',
            overallScore: 5,
            resultKind: 'scored',
          },
        ],
        rank,
      );
      expect(resolved?.source).toBe('account');
    },
  );

  test.failing.each([[null], [''], [' '], [[]], [false]])(
    'S2: rating %p must be rejected with the typed error, not coerced to 0',
    rating => {
      expect(() =>
        parsePlayerRank({ rank: { ...SERVER_RANK_BASE, rating } }),
      ).toThrow(PlayerRankApiError);
    },
  );

  test.failing.each([[7.5], [5e-324], [-1]])(
    'S3: techniqueCount %p (not a non-negative integer) must be rejected',
    techniqueCount => {
      expect(() =>
        parsePlayerRank({
          rank: { ...SERVER_RANK_BASE, rating: 6, techniqueCount },
        }),
      ).toThrow(PlayerRankApiError);
    },
  );

  const corruptFact = (overrides: Record<string, unknown>): RealAnalysisFact =>
    ({
      id: 'fact-a',
      shotType: 'dink',
      capturedAt: '2026-07-31T10:00:00.000Z',
      overallScore: 6,
      confidence: 0.9,
      resultKind: 'scored',
      scoringModelVersion: 'v1',
      shotConfigVersion: 'v1',
      sessionId: null,
      priorityCheckpoint: null,
      checkpointScores: {},
      ...overrides,
    }) as unknown as RealAnalysisFact;
  const dashboardOptions = {
    asOfIso: '2026-08-01T00:00:00.000Z',
    timeZone: 'UTC',
    range: '7d' as const,
  };

  test.failing(
    'S4a: two same-instant reads whose persisted ids are numbers must not throw out of buildTechniqueDashboard',
    () => {
      const facts = [corruptFact({ id: 1 }), corruptFact({ id: 2 })];
      expect(() =>
        buildTechniqueDashboard(facts, dashboardOptions),
      ).not.toThrow();
    },
  );

  test.failing.each([['abc'], [{}], ['']])(
    'S4b: a persisted overallScore of %p must be excluded, never averaged into NaN',
    overallScore => {
      const dashboard = buildTechniqueDashboard(
        [corruptFact({ overallScore })],
        dashboardOptions,
      );
      expect(
        dashboard.avgScore.current === null ||
          Number.isFinite(dashboard.avgScore.current),
      ).toBe(true);
      expect(dashboard.reads.every(read => Number.isFinite(read.score))).toBe(
        true,
      );
    },
  );

  test.failing(
    'S5: duprEstimate(NaN) must clamp like ±Infinity does instead of formatting "NaN"',
    () => {
      expect(Number.isFinite(duprEstimate(Number.NaN))).toBe(true);
      expect(formatDuprEstimate(Number.NaN)).not.toContain('NaN');
    },
  );

  test.failing(
    'S6: two persisted live summaries whose averages sit at ±MAX_VALUE must not yield overallDelta = ±Infinity',
    () => {
      const summary = (sessionAverage: number) =>
        JSON.stringify({
          version: 1,
          source: 'live',
          scoredCount: 1,
          sessionAverage,
        });
      const progression = buildGameplayProgression([
        {
          id: 's0',
          startedAt: '2026-08-01T10:00:00.000Z',
          endedAt: '2026-08-01T10:30:00.000Z',
          summary: summary(Number.MAX_VALUE),
        },
        {
          id: 's1',
          startedAt: '2026-08-02T10:00:00.000Z',
          endedAt: '2026-08-02T10:30:00.000Z',
          summary: summary(-Number.MAX_VALUE),
        },
      ]);
      expect(
        progression.overallDelta === null ||
          Number.isFinite(progression.overallDelta),
      ).toBe(true);
    },
  );
});

afterAll(() => {
  const byModule: Record<string, Record<Outcome | 'specNotes', number>> = {};
  const byViolation: Record<string, number> = {};
  const bySpecNote: Record<string, number> = {};
  for (const row of results) {
    const bucket = (byModule[row.module] ??= {
      HELD: 0,
      REJECTED_TYPED: 0,
      BROKEN: 0,
      specNotes: 0,
    });
    bucket[row.outcome] += 1;
    if (row.specNotes.length) bucket.specNotes += 1;
    for (const violation of row.violations)
      byViolation[violation] = (byViolation[violation] ?? 0) + 1;
    for (const note of row.specNotes) {
      const key = note.split(':')[0] ?? note;
      bySpecNote[key] = (bySpecNote[key] ?? 0) + 1;
    }
  }
  const broken = results.filter(row => row.outcome === 'BROKEN');
  const summary = {
    generatedAt: new Date().toISOString(),
    command: `STRESS_ITER=${ITER}${ONLY !== null ? ` STRESS_ONLY=${ONLY}` : ''}${MODULE_FILTER ? ` STRESS_MODULE=${MODULE_FILTER}` : ''} npx jest --ci --silent progressRankBoundaryMalformed`,
    seeds: SEEDS.length,
    scenariosExecuted: results.length,
    outcomes: {
      HELD: results.filter(row => row.outcome === 'HELD').length,
      REJECTED_TYPED: results.filter(row => row.outcome === 'REJECTED_TYPED')
        .length,
      BROKEN: broken.length,
    },
    scenariosWithSpecNotes: results.filter(row => row.specNotes.length > 0)
      .length,
    wallMs: Date.now() - wallStart,
    byModule,
    byViolation,
    bySpecNote,
    brokenSeeds: broken.map(row => ({
      seed: row.seed,
      module: row.module,
      family: row.family,
      violations: row.violations,
      input: row.input,
      replay: replayCommand(row.seed, row.module),
    })),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const stem = `progress-rank-boundary-${ITER}${ONLY !== null ? `-seed${ONLY}` : ''}${MODULE_FILTER ? `-${MODULE_FILTER}` : ''}`;
  writeFileSync(
    join(OUT_DIR, `${stem}.summary.json`),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, `${stem}.results.json`),
    JSON.stringify(
      {
        command: summary.command,
        columns: [
          'seed',
          'module',
          'family',
          'outcome',
          'violations',
          'specNotes',
          'input',
          'ms',
        ],
        rows: results,
      },
      null,
      0,
    ),
  );
});

type Outcome = ScenarioResult['outcome'];
