/**
 * MALFORMED-INPUT STRESS — liveSessionSummary.ts + sessionProgress.ts.
 *
 * Seeded fuzzing of the durable summary parser and the progression fold
 * with the shapes a concurrent/late-settling session can leave behind:
 * shuffled / duplicated / half-settled event views, garbage states, null
 * analyses, NaN / Infinity / negative / huge / fractional numbers, wrong
 * versions, foreign payloads, truncated or corrupted JSON, unicode, and
 * `__proto__` keys.
 *
 * Invariants:
 *   S1 parseLiveSessionSummaryRecord never throws on any input
 *   S2 well-formed build → stringify → parse is lossless
 *   S3 every non-null parse satisfies the V1 type invariants
 *   S4 parse ∘ stringify ∘ parse is idempotent
 *   S5 sessionScoreProgression never throws, is order-independent, and its
 *      buckets never exceed the event count
 *   S6 with finite inputs, every numeric output of progression + build is
 *      finite-or-null and JSON.stringify(record) round-trips (S2)
 *   S7 replay determinism
 *
 * Campaign size: STRESS_ITER (default 60; the full run uses 500). Each seed
 * fuzzes 24 mutated payloads and 4 event-view sets.
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import type {
  LiveSessionSnapshot,
  SessionEventView,
} from '../../src/flow/session';
import { sessionScoreProgression } from '../../src/flow/sessionProgress';
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
  type LiveSessionSummaryRecordV1,
} from '../../src/flow/liveSessionSummary';
import type { LiveCoachRecap } from '../../src/flow/liveSessionCoach';
import {
  ResultsTable,
  Violations,
  campaignSeeds,
  canonicalJson,
  describeViolations,
  firstDifference,
  mulberry32,
  type Rng,
} from './liveCourtStress.support.test';

const CAMPAIGN = 'liveSessionSummary.malformed';
const DEFAULT_ITERATIONS = 60;
const MUTATIONS_PER_SEED = 24;
const VIEW_SETS_PER_SEED = 4;

const WEIRD_NUMBERS = [
  0,
  -0,
  -1,
  1.5,
  -1.5,
  1e-9,
  1e21,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  Number.MIN_SAFE_INTEGER - 2,
  Number.MAX_VALUE,
  Number.EPSILON,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];
const WEIRD_VALUES: unknown[] = [
  null,
  undefined,
  '',
  '1',
  'NaN',
  true,
  false,
  [],
  [1, 2],
  {},
  { nested: { deep: true } },
  '🥒'.repeat(50),
  '\u0000',
  'live',
  'replay',
  'LIVE',
  1,
  '1.0',
];

function weirdNumber(rng: Rng): number {
  return rng.pick(WEIRD_NUMBERS);
}
function weirdValue(rng: Rng): unknown {
  return rng.chance(0.4) ? weirdNumber(rng) : rng.pick(WEIRD_VALUES);
}

// ─── Event-view generation (well-formed and malformed) ──────────────────────

function analysisFor(
  rng: Rng,
  kind: 'scored' | 'low' | 'null_result' | 'scored_null',
): AnalysisRecord {
  const result =
    kind === 'null_result'
      ? null
      : kind === 'low'
        ? { resultKind: 'low_confidence', overallScore: null, checkpoints: [] }
        : {
            resultKind: 'scored',
            overallScore:
              kind === 'scored_null' ? null : Math.round(rng.int(20, 100)) / 10,
            checkpoints: [],
          };
  return {
    strokeResolution: { kind: 'unresolved' },
    result,
  } as unknown as AnalysisRecord;
}

function wellFormedViews(rng: Rng, count: number): SessionEventView[] {
  return Array.from({ length: count }, (_, index) => {
    const roll = rng.next();
    const state =
      roll < 0.5
        ? 'ready'
        : roll < 0.65
          ? 'abstained'
          : roll < 0.85
            ? 'pending'
            : 'processing';
    const analysisKind = rng.pick([
      'scored',
      'scored',
      'scored',
      'low',
      'null_result',
      'scored_null',
    ] as const);
    return {
      eventId: `E${index + 1}`,
      index,
      startMs: index * 1000,
      endMs: index * 1000 + 400,
      peakMs: index * 1000 + 200,
      durationMs: 400,
      peakSpeed: 2.5,
      paddleConfirmed: true,
      closeReason: 'settle',
      closedAtMs: index * 1000 + 600,
      state,
      pendingReason: state === 'pending' ? 'CLIP_NOT_READY' : null,
      abstainReason: state === 'abstained' ? 'POSE_TOO_SPARSE' : null,
      analysis: state === 'ready' ? analysisFor(rng, analysisKind) : null,
      family: null,
      boundaryUncertain: false,
      retroSuppressed: false,
    };
  });
}

/** Views a buggy or concurrent producer might hand over: duplicated ids,
 * repeated indexes, garbage states, NaN scores, missing analysis on ready. */
function malformedViews(
  rng: Rng,
  base: SessionEventView[],
): { views: SessionEventView[]; finite: boolean } {
  let finite = true;
  const views = base.map(view => {
    const copy: SessionEventView = {
      ...view,
      analysis: view.analysis ? { ...view.analysis } : null,
    };
    const roll = rng.next();
    if (roll < 0.15) {
      (copy as { state: string }).state = rng.pick([
        'READY',
        'done',
        '',
        'ready ',
        'unknown',
      ]);
    } else if (roll < 0.3 && copy.state === 'ready') {
      copy.analysis = null; // ready without a record — upstream contract violation
    } else if (
      roll < 0.45 &&
      copy.analysis?.result &&
      copy.analysis.result.resultKind === 'scored'
    ) {
      const score = weirdNumber(rng);
      // Only in-domain magnitudes count as "finite inputs" for S6; a score of
      // MAX_VALUE legitimately overflows a mean.
      if (!Number.isFinite(score) || Math.abs(score) > 1e6) finite = false;
      (copy.analysis as { result: { overallScore: number } }).result = {
        ...(copy.analysis.result as object),
        overallScore: score,
      } as { overallScore: number };
    } else if (roll < 0.55) {
      copy.index = rng.pick([-1, 0, copy.index, copy.index, 1e9]);
    } else if (roll < 0.65) {
      copy.eventId = rng.pick(['', 'E1', copy.eventId, 'E-1', '💥']);
    }
    return copy;
  });
  if (rng.chance(0.3) && views.length > 0)
    views.push({ ...(rng.pick(views) as SessionEventView) }); // duplicate row
  return { views: rng.shuffle(views), finite };
}

function snapshotFor(rng: Rng, views: SessionEventView[]): LiveSessionSnapshot {
  return {
    sessionId: 'summary-fuzz',
    phase: 'ended',
    source: rng.chance(0.5) ? 'live' : 'replay',
    startedAtIso: null,
    durationMs: rng.pick([0, 1, 1234, 599_999, 3_600_000]),
    strokeCount: views.length,
    events: views,
    distribution: [],
    qualityNotes: [],
    droppedLateSamples: 0,
    onUpdateFailures: 0,
    engineVersion: rng.pick(['stress-engine', '', 'v1.0.0-🥒']),
    analysisProviderId: 'p',
  };
}

function recapFor(rng: Rng): LiveCoachRecap | null {
  if (rng.chance(0.2)) return null;
  const keys = rng
    .shuffle(['contact_position', 'athletic_base', 'follow_through'])
    .slice(0, rng.int(0, 3));
  const corrections: Record<string, number> = {};
  for (const key of keys) corrections[key] = rng.int(1, 9);
  return {
    cues: [],
    spokenCount: rng.int(0, 40),
    correctionsByCheckpoint: corrections,
    topCorrection: keys[0] ?? null,
  } as unknown as LiveCoachRecap;
}

// ─── Payload mutation ───────────────────────────────────────────────────────

const RECORD_KEYS: Array<keyof LiveSessionSummaryRecordV1> = [
  'version',
  'engineVersion',
  'source',
  'durationMs',
  'strokeCount',
  'scoredCount',
  'noReadCount',
  'pendingCount',
  'startAverage',
  'endAverage',
  'delta',
  'bestScore',
  'sessionAverage',
  'cuesSpoken',
  'topCorrection',
  'correctionsByCheckpoint',
];

function mutatePayload(
  rng: Rng,
  record: LiveSessionSummaryRecordV1,
): string | null {
  const roll = rng.next();
  const clone = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  if (roll < 0.05) return null;
  if (roll < 0.1)
    return rng.pick([
      '',
      'null',
      '[]',
      '"live"',
      '42',
      'undefined',
      '{',
      '{"version":1',
      '\uFEFF{}',
    ]);
  if (roll < 0.2) {
    const json = JSON.stringify(record);
    return json.slice(0, rng.int(0, json.length)); // truncated
  }
  if (roll < 0.3) {
    const json = JSON.stringify(record);
    const at = rng.int(0, Math.max(0, json.length - 1));
    return `${json.slice(0, at)}${rng.pick(['"', '}', ',', 'NaN', '\\', '💥'])}${json.slice(at + 1)}`; // corrupted
  }
  const edits = rng.int(1, 4);
  for (let i = 0; i < edits; i += 1) {
    const key = rng.pick(RECORD_KEYS);
    const op = rng.next();
    if (op < 0.2) delete clone[key];
    else if (op < 0.85) clone[key] = weirdValue(rng);
    else if (key === 'correctionsByCheckpoint') {
      clone[key] = rng.pick([
        { contact_position: weirdNumber(rng) },
        { '': 1, __proto__: { polluted: true } },
        { a: '1', b: 2.5, c: -3, d: 4 },
        [],
        'x',
        null,
      ]);
    } else clone[key] = weirdValue(rng);
  }
  if (rng.chance(0.1)) clone['__proto__'] = { polluted: true };
  if (rng.chance(0.1)) clone['extra'] = { foreign: true };
  return JSON.stringify(clone, (_k, v: unknown) =>
    typeof v === 'number' && !Number.isFinite(v) ? String(v) : v,
  );
}

function typeInvariants(parsed: LiveSessionSummaryRecordV1): string[] {
  const problems: string[] = [];
  if (parsed.version !== 1) problems.push(`version=${String(parsed.version)}`);
  if (parsed.source !== 'live' && parsed.source !== 'replay')
    problems.push(`source=${String(parsed.source)}`);
  if (typeof parsed.engineVersion !== 'string')
    problems.push('engineVersion not string');
  for (const key of [
    'durationMs',
    'strokeCount',
    'scoredCount',
    'noReadCount',
    'pendingCount',
    'cuesSpoken',
  ] as const) {
    const value = parsed[key];
    if (!(Number.isSafeInteger(value) && value >= 0))
      problems.push(`${key}=${String(value)}`);
  }
  for (const key of [
    'startAverage',
    'endAverage',
    'delta',
    'bestScore',
    'sessionAverage',
  ] as const) {
    const value = parsed[key];
    if (!(value === null || Number.isFinite(value)))
      problems.push(`${key}=${String(value)}`);
  }
  if (!(
    parsed.topCorrection === null || typeof parsed.topCorrection === 'string'
  ))
    problems.push('topCorrection');
  if (
    typeof parsed.correctionsByCheckpoint !== 'object' ||
    parsed.correctionsByCheckpoint === null ||
    Array.isArray(parsed.correctionsByCheckpoint)
  ) {
    problems.push('correctionsByCheckpoint not a record');
  } else {
    for (const [key, value] of Object.entries(parsed.correctionsByCheckpoint)) {
      if (!Number.isSafeInteger(value))
        problems.push(`corrections[${key}]=${String(value)}`);
    }
  }
  return problems;
}

function allFiniteOrNull(values: Array<number | null>): boolean {
  return values.every(value => value === null || Number.isFinite(value));
}

interface FuzzTrace {
  fingerprint: string;
  parses: number;
  progressions: number;
}

function runFuzz(seed: number, violations: Violations): FuzzTrace {
  const rng = mulberry32(seed);
  const fingerprints: string[] = [];
  let parses = 0;
  let progressions = 0;

  for (let set = 0; set < VIEW_SETS_PER_SEED; set += 1) {
    const base = wellFormedViews(rng, rng.int(0, 30));
    const { views: bad, finite } = malformedViews(rng, base);

    for (const [label, views, isFinite] of [
      ['wellformed', base, true],
      ['malformed', bad, finite],
    ] as const) {
      let progression;
      try {
        progression = sessionScoreProgression(views);
        progressions += 1;
      } catch (error) {
        violations.fail('S5', `${label}: progression threw ${String(error)}`);
        continue;
      }
      const shuffledProgression = sessionScoreProgression(rng.shuffle(views));
      // Order independence is a contract for engine-produced views (unique
      // indexes). For malformed views with repeated indexes it is recorded as
      // an observation, not a broken invariant.
      violations.check(
        label === 'wellformed' ? 'S5' : 'OBS-S5-order-malformed',
        canonicalJson(shuffledProgression) === canonicalJson(progression),
        () =>
          `${label}: progression depends on view order: ${firstDifference(canonicalJson(progression), canonicalJson(shuffledProgression))}`,
      );
      violations.check(
        'S5',
        progression.scoredCount +
          progression.noReadCount +
          progression.pendingCount <=
          views.length && progression.points.length === progression.scoredCount,
        () =>
          `${label}: buckets ${progression.scoredCount}+${progression.noReadCount}+${progression.pendingCount} > ${views.length}`,
      );
      const snapshot = snapshotFor(rng, views);
      const recap = recapFor(rng);
      let record: LiveSessionSummaryRecordV1;
      try {
        record = buildLiveSessionSummaryRecord(snapshot, progression, recap);
      } catch (error) {
        violations.fail('S6', `${label}: build threw ${String(error)}`);
        continue;
      }
      if (isFinite) {
        violations.check(
          'S6',
          allFiniteOrNull([
            progression.startAverage,
            progression.endAverage,
            progression.delta,
            progression.best?.score ?? null,
            record.startAverage,
            record.endAverage,
            record.delta,
            record.bestScore,
            record.sessionAverage,
          ]),
          () =>
            `${label}: non-finite output from finite inputs: ${canonicalJson(record)}`,
        );
        const parsed = parseLiveSessionSummaryRecord(JSON.stringify(record));
        parses += 1;
        violations.check(
          'S2',
          canonicalJson(parsed) === canonicalJson(record),
          () =>
            `${label}: round trip changed ${canonicalJson(record)} → ${canonicalJson(parsed)}`,
        );
      }
      fingerprints.push(canonicalJson(record));

      // Mutations of this record.
      for (let m = 0; m < MUTATIONS_PER_SEED / 2; m += 1) {
        const payload = mutatePayload(rng, record);
        let parsed: LiveSessionSummaryRecordV1 | null;
        try {
          parsed = parseLiveSessionSummaryRecord(payload);
          parses += 1;
        } catch (error) {
          violations.fail(
            'S1',
            `parse threw on ${JSON.stringify(payload)}: ${String(error)}`,
          );
          continue;
        }
        if (parsed === null) {
          fingerprints.push('null');
          continue;
        }
        const problems = typeInvariants(parsed);
        violations.check(
          'S3',
          problems.length === 0,
          () =>
            `parsed record violates type: ${problems.join('; ')} ← ${JSON.stringify(payload)}`,
        );
        const again = parseLiveSessionSummaryRecord(JSON.stringify(parsed));
        violations.check(
          'S4',
          canonicalJson(again) === canonicalJson(parsed),
          () =>
            `parse not idempotent: ${canonicalJson(parsed)} → ${canonicalJson(again)}`,
        );
        fingerprints.push(canonicalJson(parsed));
      }
    }
  }
  return { fingerprint: canonicalJson(fingerprints), parses, progressions };
}

const table = new ResultsTable(CAMPAIGN);
const seeds = campaignSeeds(DEFAULT_ITERATIONS);

beforeAll(() => {
  for (const seed of seeds) {
    const started = Date.now();
    const violations = new Violations();
    let counters: Record<string, number> = {};
    try {
      const first = runFuzz(seed, violations);
      const second = runFuzz(seed, new Violations());
      violations.check(
        'S7',
        first.fingerprint === second.fingerprint,
        () => `replay diverged`,
      );
      counters = {
        parses: first.parses,
        progressions: first.progressions,
        iterations: 2,
      };
    } catch (error) {
      violations.fail(
        'S0',
        `harness threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
    table.record({
      seed,
      outcome:
        violations.ids().filter(id => !id.startsWith('OBS')).length === 0
          ? 'HELD'
          : 'BROKEN',
      violated: violations.ids(),
      details: violations.messages(),
      counters,
      durationMs: Date.now() - started,
    });
  }
}, 600_000);

afterAll(() => {
  const path = table.write();
  const summary = table.summary();
  console.info(
    `[${CAMPAIGN}] seeds=${summary.seeds} held=${summary.held} broken=${summary.broken} ` +
      `totals=${JSON.stringify(summary.totals)}` +
      (path ? ` table=${path}` : ''),
  );
});

describe(`liveSessionSummary + sessionProgress malformed-input campaign (${seeds.length} seeds)`, () => {
  it('ran every planned seed (harness itself never threw)', () => {
    expect(table.summary().seeds).toBe(seeds.length);
    expect(describeViolations(table, 'S0')).toBe('S0: held on every seed');
  });
  it('S1 parseLiveSessionSummaryRecord never throws', () => {
    expect(describeViolations(table, 'S1')).toBe('S1: held on every seed');
  });
  it('S2 build → stringify → parse is lossless for well-formed records', () => {
    expect(describeViolations(table, 'S2')).toBe('S2: held on every seed');
  });
  it('S3 every non-null parse satisfies the V1 type invariants', () => {
    expect(describeViolations(table, 'S3')).toBe('S3: held on every seed');
  });
  it('S4 parse is idempotent', () => {
    expect(describeViolations(table, 'S4')).toBe('S4: held on every seed');
  });
  it('S5 sessionScoreProgression never throws, ignores order, and never over-counts', () => {
    expect(describeViolations(table, 'S5')).toBe('S5: held on every seed');
  });
  it('S6 finite inputs never yield non-finite outputs', () => {
    expect(describeViolations(table, 'S6')).toBe('S6: held on every seed');
  });
  it('S7 every seed replays identically', () => {
    expect(describeViolations(table, 'S7')).toBe('S7: held on every seed');
  });
});
