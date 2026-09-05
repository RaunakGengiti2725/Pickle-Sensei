/**
 * STRESS · failure-injection · liveSessionSummary (src/flow/liveSessionSummary.ts)
 * + its SQLite seam (data/repository.ts listLiveSessionHistory →
 * progress/gameplayProgression.ts buildGameplayProgression).
 *
 * The summary record is the ONLY Live Court state that outlives the session
 * (local_session.summary). Injected here:
 *   persisted JSON      → 10 000 seeded corruptions of a valid V1 record:
 *                         type swaps, deletions, NaN/Infinity (→ null in
 *                         JSON), negative / fractional / unsafe-huge numbers,
 *                         nested objects/arrays, `__proto__`/`constructor`
 *                         keys, truncation, byte injection, foreign payloads,
 *                         non-object roots, deep nesting.
 *   build inputs        → snapshots / progressions / recaps carrying NaN,
 *                         Infinity, negative, fractional, huge values.
 *   SQLite (LocalDb)    → execute(): throw | reject | timeout | malformed
 *                         rows | partial rows | slow | never-resolves.
 *
 * Invariants:
 *   S1 parse never throws for any string (corruption is data, not a crash).
 *   S2 parse output is always a valid V1 record or null: counts are safe
 *      non-negative integers, averages finite-or-null, source ∈ {live,
 *      replay}, corrections values safe integers, Object.prototype is never
 *      polluted.
 *   S3 parse is idempotent: parse(stringify(parse(x))) ≡ parse(x).
 *   S4 no fake history: non-object / wrong-version / wrong-source rows
 *      parse to null (excluded from progression), never coerced.
 *   S5 no corrupted persisted state: build → stringify → parse round-trips
 *      every field of a record built from finite inputs.
 *   S6 buildGameplayProgression over corrupt rows never throws, counts
 *      exactly the rows that parse to source 'live', totals are finite.
 *   S7 SQLite faults: a rejected/thrown query propagates to the caller
 *      (never an empty history = fake success); malformed rows are excluded
 *      downstream; a never-resolving query is still pending after 60 s of
 *      fake time (recorded — the repository has no timeout of its own).
 *
 * Scale: STRESS_ITER seeds (default 5) × 2 000 payloads = 10 000 payloads.
 *        STRESS_SEED=<n> replays one seed.
 * Output: artifacts/stress/live-court/liveSessionSummaryFaults.json
 */
import {
  buildLiveSessionSummaryRecord,
  parseLiveSessionSummaryRecord,
  type LiveSessionSummaryRecordV1,
} from '../../src/flow/liveSessionSummary';
import { sessionScoreProgression } from '../../src/flow/sessionProgress';
import type { LiveCoachRecap } from '../../src/flow/liveSessionCoach';
import type { LiveSessionSnapshot } from '../../src/flow/session';
import type { LocalDb } from '../../src/data/db';
import { listLiveSessionHistory } from '../../src/data/repository';
import { buildGameplayProgression } from '../../src/progress/gameplayProgression';
import {
  FAULT_MODES,
  INJECTED_FAULT_MODES,
  InjectedFault,
  SLOW_MS,
  TIMEOUT_MS,
  WATCHDOG_MS,
  applyAsyncFault,
  assertKnownBrokenStillReproduce,
  assertSeedOutcome,
  buildTable,
  campaignSeeds,
  canonicalJson,
  eventView,
  malformedAnalysis,
  mulberry32,
  randomScoredAnalysis,
  scoredAnalysis,
  snapshotOf,
  writeArtifact,
  type FaultMode,
  type KnownBroken,
  type Rng,
  type SeedOutcome,
} from '../../test-support/stress/liveCourtStressKit';

const SUITE = 'liveSessionSummaryFaults';
const PAYLOADS_PER_SEED = 2_000;

const KNOWN_BROKEN: readonly KnownBroken[] = [
  {
    finding: 'LSS-1',
    violationClass: 'S5:roundtrip_durationMs_zeroed',
    observed:
      'buildLiveSessionSummaryRecord persists snapshot.durationMs verbatim (any finite number), but ' +
      'parseLiveSessionSummaryRecord reads it back through countOrZero (Number.isSafeInteger) — a fractional ' +
      'duration such as 61234.5 ms is stored, then read back as 0.',
  },
];

// ─── Valid record generator ─────────────────────────────────────────────────

function validRecord(rng: Rng): LiveSessionSummaryRecordV1 {
  const scored = rng.int(0, 40);
  const avg = (): number | null =>
    scored === 0 ? null : Math.round(rng.next() * 100) / 10;
  return {
    version: 1,
    engineVersion: `stress-${rng.int(1, 9)}.${rng.int(0, 9)}`,
    source: rng.chance(0.8) ? 'live' : 'replay',
    durationMs: rng.int(0, 3_600_000),
    strokeCount: scored + rng.int(0, 20),
    scoredCount: scored,
    noReadCount: rng.int(0, 10),
    pendingCount: rng.int(0, 5),
    startAverage: avg(),
    endAverage: avg(),
    delta: scored >= 2 ? Math.round((rng.next() * 6 - 3) * 10) / 10 : null,
    bestScore: avg(),
    sessionAverage: avg(),
    cuesSpoken: rng.int(0, 60),
    topCorrection: rng.chance(0.6)
      ? rng.pick(['contact_position', 'paddle_path', 'follow_through'])
      : null,
    correctionsByCheckpoint: rng.chance(0.7)
      ? { contact_position: rng.int(0, 9), paddle_path: rng.int(0, 9) }
      : {},
  };
}

// ─── Corruption operators ───────────────────────────────────────────────────

const CORRUPTIONS = [
  'delete_key',
  'type_swap_string',
  'type_swap_bool',
  'type_swap_object',
  'type_swap_array',
  'null_field',
  'negative',
  'fractional',
  'unsafe_huge',
  'nonfinite',
  'wrong_version',
  'wrong_source',
  'proto_key',
  'constructor_key',
  'corrections_garbage',
  'corrections_proto',
  'truncate',
  'inject_bytes',
  'non_object_root',
  'deep_nesting',
  'foreign_payload',
  'duplicate_keys',
  'extra_keys',
  'empty_string',
  'whitespace',
] as const;
type Corruption = (typeof CORRUPTIONS)[number];

const RECORD_KEYS: readonly (keyof LiveSessionSummaryRecordV1)[] = [
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

interface Payload {
  id: string;
  corruptions: Corruption[];
  json: string;
  /** The un-corrupted origin, for expectation derivation. */
  origin: LiveSessionSummaryRecordV1;
}

function corruptRecord(
  rng: Rng,
  record: Record<string, unknown>,
  op: Corruption,
): Record<string, unknown> {
  const key = rng.pick(RECORD_KEYS);
  const out: Record<string, unknown> = { ...record };
  switch (op) {
    case 'delete_key':
      delete out[key];
      break;
    case 'type_swap_string':
      out[key] = rng.pick(['7.5', 'NaN', '', 'live', '1', 'true', 'null']);
      break;
    case 'type_swap_bool':
      out[key] = rng.chance(0.5);
      break;
    case 'type_swap_object':
      out[key] = { nested: rng.int(0, 9) };
      break;
    case 'type_swap_array':
      out[key] = [rng.int(0, 9), 'x'];
      break;
    case 'null_field':
      out[key] = null;
      break;
    case 'negative':
      out[key] = -rng.int(1, 1_000_000);
      break;
    case 'fractional':
      out[key] = rng.int(0, 1_000_000) + 0.5;
      break;
    case 'unsafe_huge':
      out[key] = rng.pick([
        Number.MAX_SAFE_INTEGER + 2,
        1e300,
        2 ** 53 + 1,
        -(2 ** 53) - 1,
      ]);
      break;
    case 'nonfinite':
      // JSON.stringify turns these into null — that IS the persisted shape.
      out[key] = rng.pick([NaN, Infinity, -Infinity]);
      break;
    case 'wrong_version':
      out.version = rng.pick([0, 2, '1', null, 1.0000001, true]);
      break;
    case 'wrong_source':
      out.source = rng.pick(['LIVE', 'Live', 'replay ', 'dev', '', null, 1]);
      break;
    case 'proto_key':
      out.__proto__ = { polluted: true };
      break;
    case 'constructor_key':
      out['constructor'] = { prototype: { polluted: true } };
      break;
    case 'corrections_garbage':
      out.correctionsByCheckpoint = rng.pick([
        {
          contact_position: 'many',
          paddle_path: NaN,
          follow_through: 1.5,
          ready_position: -1,
          kinetic_chain: 2 ** 60,
        },
        [1, 2, 3],
        'contact_position:3',
        42,
        null,
      ]);
      break;
    case 'corrections_proto':
      out.correctionsByCheckpoint = {
        __proto__: { polluted: true },
        contact_position: 2,
      };
      break;
    case 'extra_keys':
      out[`extra_${rng.int(0, 99)}`] = { deep: [1, { deeper: 'x' }] };
      break;
    case 'duplicate_keys':
    case 'truncate':
    case 'inject_bytes':
    case 'non_object_root':
    case 'deep_nesting':
    case 'foreign_payload':
    case 'empty_string':
    case 'whitespace':
      // string-level operators — applied in corruptJson()
      break;
  }
  return out;
}

function corruptJson(rng: Rng, json: string, op: Corruption): string {
  switch (op) {
    case 'truncate':
      return json.slice(0, rng.int(0, json.length - 1));
    case 'inject_bytes': {
      const at = rng.int(0, json.length);
      const bytes = rng.pick([
        '\u0000',
        '"',
        '{',
        '}',
        ',',
        '\\',
        'é',
        '\uD800',
        ']',
        ':',
      ]);
      return json.slice(0, at) + bytes + json.slice(at);
    }
    case 'non_object_root':
      return rng.pick([
        'null',
        '1',
        '"live"',
        'true',
        '[]',
        '[1,2]',
        '{}',
        '"{\\"version\\":1}"',
      ]);
    case 'deep_nesting': {
      const depth = rng.int(50, 500);
      return `${'['.repeat(depth)}${']'.repeat(depth)}`;
    }
    case 'foreign_payload':
      return rng.pick([
        '{"version":1,"source":"live"}',
        '{"version":1,"source":"live","scoredCount":"3","strokeCount":true}',
        '{"mode":"technique_rating","overallScore":7.2}',
        '{"version":2,"source":"live","scoredCount":3}',
        '{"version":1,"source":"replay","scoredCount":9,"sessionAverage":8.8}',
      ]);
    case 'duplicate_keys':
      // JSON.parse keeps the LAST duplicate: a legit-looking record whose
      // real scoredCount is overridden by trailing garbage.
      return `${json.slice(0, -1)},"scoredCount":"9","source":"live"}`;
    case 'empty_string':
      return '';
    case 'whitespace':
      return `  \n\t${json}\n  `;
    default:
      return json;
  }
}

function makePayload(rng: Rng, index: number): Payload {
  const origin = validRecord(rng);
  const corruptions: Corruption[] = [];
  const count = rng.chance(0.1) ? 0 : rng.int(1, 3);
  let record: Record<string, unknown> = { ...origin };
  for (let i = 0; i < count; i += 1) {
    const op = rng.pick(CORRUPTIONS);
    corruptions.push(op);
    record = corruptRecord(rng, record, op);
  }
  let json = JSON.stringify(record);
  for (const op of corruptions) json = corruptJson(rng, json, op);
  return { id: `P${index}`, corruptions, json, origin };
}

// ─── Validity oracle for parsed records ─────────────────────────────────────

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteOrNull(value: unknown): boolean {
  return (
    value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

function recordViolations(
  id: string,
  record: LiveSessionSummaryRecordV1,
): string[] {
  const violations: string[] = [];
  if (record.version !== 1)
    violations.push(`S2:version(${id})=${String(record.version)}`);
  if (record.source !== 'live' && record.source !== 'replay') {
    violations.push(`S2:source(${id})=${String(record.source)}`);
  }
  if (typeof record.engineVersion !== 'string')
    violations.push(`S2:engineVersion(${id})`);
  for (const key of [
    'durationMs',
    'strokeCount',
    'scoredCount',
    'noReadCount',
    'pendingCount',
    'cuesSpoken',
  ] as const) {
    if (!isCount(record[key]))
      violations.push(`S2:count_${key}(${id})=${String(record[key])}`);
  }
  for (const key of [
    'startAverage',
    'endAverage',
    'delta',
    'bestScore',
    'sessionAverage',
  ] as const) {
    if (!isFiniteOrNull(record[key]))
      violations.push(`S2:avg_${key}(${id})=${String(record[key])}`);
  }
  if (
    record.topCorrection !== null &&
    typeof record.topCorrection !== 'string'
  ) {
    violations.push(`S2:topCorrection(${id})`);
  }
  if (
    typeof record.correctionsByCheckpoint !== 'object' ||
    record.correctionsByCheckpoint === null ||
    Array.isArray(record.correctionsByCheckpoint)
  ) {
    violations.push(`S2:corrections_shape(${id})`);
  } else {
    for (const [key, value] of Object.entries(record.correctionsByCheckpoint)) {
      if (!Number.isSafeInteger(value))
        violations.push(`S2:corrections_value(${id}).${key}=${String(value)}`);
    }
  }
  if (Object.getPrototypeOf(record) !== Object.prototype)
    violations.push(`S2:prototype_swapped(${id})`);
  if (
    Object.getPrototypeOf(record.correctionsByCheckpoint) !== Object.prototype
  ) {
    violations.push(`S2:corrections_prototype_swapped(${id})`);
  }
  return violations;
}

function prototypePolluted(): boolean {
  return (
    ({} as Record<string, unknown>).polluted !== undefined ||
    (Object.prototype as Record<string, unknown>).polluted !== undefined
  );
}

// ─── One seed of the parse campaign ─────────────────────────────────────────

function runParseSeed(seed: number): SeedOutcome & { canonical: string } {
  const rng = mulberry32(seed);
  const violations: string[] = [];
  const faults = new Set<string>();
  const canonicalParts: string[] = [];
  let parsedNonNull = 0;
  let parsedNull = 0;
  for (let i = 0; i < PAYLOADS_PER_SEED; i += 1) {
    const payload = makePayload(rng, i);
    for (const op of payload.corruptions)
      faults.add(`sqlite.summary_row:${op}`);
    let parsed: LiveSessionSummaryRecordV1 | null;
    try {
      parsed = parseLiveSessionSummaryRecord(payload.json);
    } catch (error) {
      violations.push(
        `S1:parse_threw(${payload.id}) ops=${payload.corruptions.join('+')}: ${String(error)}`,
      );
      canonicalParts.push(`${payload.id}:threw`);
      continue;
    }
    if (prototypePolluted()) {
      violations.push(
        `S2:prototype_polluted(${payload.id}) ops=${payload.corruptions.join('+')}`,
      );
      delete (Object.prototype as Record<string, unknown>).polluted;
    }
    canonicalParts.push(`${payload.id}:${canonicalJson(parsed)}`);
    if (parsed === null) {
      parsedNull += 1;
      // S4 (inverse): an UNTOUCHED record must parse.
      if (payload.corruptions.length === 0)
        violations.push(`S4:valid_record_rejected(${payload.id})`);
      continue;
    }
    parsedNonNull += 1;
    violations.push(...recordViolations(payload.id, parsed));
    // S3 idempotent
    const again = parseLiveSessionSummaryRecord(JSON.stringify(parsed));
    if (canonicalJson(again) !== canonicalJson(parsed)) {
      violations.push(
        `S3:not_idempotent(${payload.id}) ops=${payload.corruptions.join('+')}`,
      );
    }
    // S4: fake history — rows that must be null
    let root: unknown = null;
    try {
      root = JSON.parse(payload.json);
    } catch {
      violations.push(`S4:unparseable_json_accepted(${payload.id})`);
    }
    if (root !== null && typeof root === 'object' && !Array.isArray(root)) {
      const r = root as Record<string, unknown>;
      if (r.version !== 1)
        violations.push(
          `S4:wrong_version_accepted(${payload.id})=${String(r.version)}`,
        );
      if (r.source !== 'live' && r.source !== 'replay') {
        violations.push(
          `S4:wrong_source_accepted(${payload.id})=${String(r.source)}`,
        );
      }
      // No synthesized counts: a count that is not a valid count in the row
      // must read back as 0, never as something else.
      for (const key of ['scoredCount', 'strokeCount', 'cuesSpoken'] as const) {
        if (!isCount(r[key]) && parsed[key] !== 0) {
          violations.push(
            `S4:count_synthesized(${payload.id}).${key}=${String(parsed[key])}`,
          );
        }
        if (isCount(r[key]) && parsed[key] !== r[key]) {
          violations.push(
            `S4:count_altered(${payload.id}).${key}=${String(parsed[key])}!=${String(r[key])}`,
          );
        }
      }
    } else {
      violations.push(`S4:non_object_root_accepted(${payload.id})`);
    }
  }
  return {
    seed,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    iterations: PAYLOADS_PER_SEED,
    faultsInjected: [...faults].sort(),
    violations,
    detail: { parsedNonNull, parsedNull },
    canonical: canonicalParts.join('\n'),
  };
}

// ─── Build-side inputs ──────────────────────────────────────────────────────

function recapOf(rng: Rng): LiveCoachRecap | null {
  if (rng.chance(0.2)) return null;
  const spokenCount = rng.int(0, 30);
  return {
    cues: [],
    spokenCount,
    correctionsByCheckpoint: {
      contact_position: rng.int(0, 9),
      paddle_path: rng.int(0, 9),
    },
    topCorrection: rng.chance(0.5) ? 'contact_position' : null,
  };
}

function healthySnapshot(rng: Rng, sessionId: string): LiveSessionSnapshot {
  const n = rng.int(0, 30);
  const events = Array.from({ length: n }, (_, i) => {
    const roll = rng.next();
    if (roll < 0.65)
      return eventView(i, {
        state: 'ready',
        analysis: randomScoredAnalysis(rng),
      });
    if (roll < 0.8)
      return eventView(i, { state: 'abstained', abstainReason: 'STRESS' });
    if (roll < 0.9)
      return eventView(i, { state: 'pending', pendingReason: 'STRESS' });
    return eventView(i, {
      state: 'ready',
      analysis: scoredAnalysis(rng.int(1, 10), []),
    });
  });
  return snapshotOf(sessionId, events, {
    phase: 'ended',
    durationMs: rng.int(0, 3_600_000),
    strokeCount: n,
  });
}

const MALFORMED_SNAPSHOT_FIELDS = [
  'durationMs=NaN',
  'durationMs=Infinity',
  'durationMs=-1',
  'durationMs=fractional',
  'durationMs=1e15',
  'durationMs=unsafe',
  'strokeCount=NaN',
  'strokeCount=-1',
  'strokeCount=fractional',
  'engineVersion=undefined',
  'score=NaN',
  'score=Infinity',
  'score=string',
  'score=negative',
  'score=>10',
  'recap.spokenCount=NaN',
  'recap.spokenCount=-3',
  'recap.corrections=garbage',
] as const;
type MalformedSnapshotField = (typeof MALFORMED_SNAPSHOT_FIELDS)[number];

function malformedBuildInputs(
  rng: Rng,
  kind: MalformedSnapshotField,
): { snapshot: LiveSessionSnapshot; recap: LiveCoachRecap | null } {
  const snapshot = healthySnapshot(rng, `mal-${kind}`);
  const recap: LiveCoachRecap = {
    cues: [],
    spokenCount: 3,
    correctionsByCheckpoint: { contact_position: 2 },
    topCorrection: 'contact_position',
  };
  const withScore = (
    analysisKind: Parameters<typeof malformedAnalysis>[0],
  ): void => {
    snapshot.events.push(
      eventView(snapshot.events.length, {
        state: 'ready',
        analysis: malformedAnalysis(analysisKind),
      }),
    );
  };
  switch (kind) {
    case 'durationMs=NaN':
      snapshot.durationMs = NaN;
      break;
    case 'durationMs=Infinity':
      snapshot.durationMs = Infinity;
      break;
    case 'durationMs=-1':
      snapshot.durationMs = -1;
      break;
    case 'durationMs=fractional':
      snapshot.durationMs = 61_234.5;
      break;
    case 'durationMs=1e15':
      snapshot.durationMs = 1e15;
      break;
    case 'durationMs=unsafe':
      snapshot.durationMs = Number.MAX_SAFE_INTEGER + 2;
      break;
    case 'strokeCount=NaN':
      snapshot.strokeCount = NaN;
      break;
    case 'strokeCount=-1':
      snapshot.strokeCount = -1;
      break;
    case 'strokeCount=fractional':
      snapshot.strokeCount = 2.5;
      break;
    case 'engineVersion=undefined':
      (snapshot as unknown as Record<string, unknown>).engineVersion =
        undefined;
      break;
    case 'score=NaN':
      withScore('overall_nan');
      break;
    case 'score=Infinity':
      withScore('overall_infinity');
      break;
    case 'score=string':
      withScore('overall_string');
      break;
    case 'score=negative':
      withScore('overall_negative');
      break;
    case 'score=>10':
      withScore('overall_over_ten');
      break;
    case 'recap.spokenCount=NaN':
      recap.spokenCount = NaN;
      break;
    case 'recap.spokenCount=-3':
      recap.spokenCount = -3;
      break;
    case 'recap.corrections=garbage':
      (recap as unknown as Record<string, unknown>).correctionsByCheckpoint = {
        contact_position: 'many',
        paddle_path: NaN,
        follow_through: 1.5,
      };
      break;
  }
  return { snapshot, recap };
}

// ─── SQLite fault injection ─────────────────────────────────────────────────

type RowShape =
  | 'healthy'
  | 'missing_columns'
  | 'summary_number'
  | 'summary_object'
  | 'id_null'
  | 'row_null';

function fakeRows(
  rng: Rng,
  shape: RowShape,
  count: number,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i += 1) {
    const record = validRecord(rng);
    const base: Record<string, unknown> = {
      id: `s${i}`,
      started_at: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
      ended_at: rng.chance(0.9)
        ? new Date(1_700_000_000_000 + i * 60_000 + 30_000).toISOString()
        : null,
      summary: JSON.stringify(record),
    };
    switch (shape) {
      case 'healthy':
        break;
      case 'missing_columns':
        delete base.summary;
        delete base.ended_at;
        break;
      case 'summary_number':
        base.summary = 42;
        break;
      case 'summary_object':
        base.summary = { version: 1, source: 'live', scoredCount: 3 };
        break;
      case 'id_null':
        base.id = null;
        break;
      case 'row_null':
        rows.push(null as unknown as Record<string, unknown>);
        continue;
    }
    rows.push(base);
  }
  return rows;
}

function faultyDb(
  mode: FaultMode,
  rows: Record<string, unknown>[],
): LocalDb & { calls: number } {
  const db = {
    calls: 0,
    async execute(): Promise<{ rows: Record<string, unknown>[] }> {
      db.calls += 1;
      return applyAsyncFault('sqlite.execute', mode, async () => ({ rows }), {
        malformed: () =>
          'not-a-result-set' as unknown as { rows: Record<string, unknown>[] },
        partial: () => ({}) as { rows: Record<string, unknown>[] },
      });
    },
    close(): void {},
  };
  return db;
}

// ─── Campaign ───────────────────────────────────────────────────────────────

describe('STRESS · liveSessionSummary parse/build × SQLite faults', () => {
  const outcomes: SeedOutcome[] = [];
  const canonicalBySeed = new Map<number, string>();

  afterAll(() => {
    const table = buildTable(SUITE, outcomes);
    writeArtifact(`${SUITE}.json`, table);
  });

  describe.each(campaignSeeds(5))('seed=%i', seed => {
    it(`parses ${PAYLOADS_PER_SEED} corrupted persisted rows without a throw, a fake record or a polluted prototype (S1–S4)`, () => {
      const run = runParseSeed(seed);
      canonicalBySeed.set(seed, run.canonical);
      const { canonical: _canonical, ...outcome } = run;
      outcomes.push(outcome);
      assertSeedOutcome(SUITE, outcome, KNOWN_BROKEN);
      expect(outcome.outcome).toBe('HELD');
    });
  });

  it('is replayable: same seed ⇒ same canonical parse table (S3-replay)', () => {
    const [seed] = campaignSeeds(5);
    const again = runParseSeed(seed!);
    expect(again.canonical).toBe(canonicalBySeed.get(seed!));
  });

  it('round-trips build → JSON → parse for 500 records built from finite inputs (S5)', () => {
    const rng = mulberry32(0x5e55);
    const violations: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      const snapshot = healthySnapshot(rng, `rt-${i}`);
      const record = buildLiveSessionSummaryRecord(
        snapshot,
        sessionScoreProgression(snapshot.events),
        recapOf(rng),
      );
      const back = parseLiveSessionSummaryRecord(JSON.stringify(record));
      if (canonicalJson(back) !== canonicalJson(record)) {
        violations.push(
          `S5:roundtrip_mismatch(rt-${i}) built=${canonicalJson(record)} back=${canonicalJson(back)}`,
        );
      }
      violations.push(...recordViolations(`rt-${i}`, record));
    }
    const outcome: SeedOutcome = {
      seed: -1,
      outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
      iterations: 500,
      faultsInjected: ['sqlite.summary_row:roundtrip'],
      violations,
    };
    outcomes.push(outcome);
    assertSeedOutcome(SUITE, outcome, KNOWN_BROKEN);
    expect(outcome.outcome).toBe('HELD');
  });

  describe.each(MALFORMED_SNAPSHOT_FIELDS.map((k, i) => [k, i] as const))(
    'SWEEP · build from malformed input %s',
    (kind, index) => {
      it('must not throw, must persist a valid record, and must read back what it wrote (S2/S5)', () => {
        const rng = mulberry32(0x6000 + index);
        const violations: string[] = [];
        const { snapshot, recap } = malformedBuildInputs(rng, kind);
        let record: LiveSessionSummaryRecordV1 | null = null;
        try {
          record = buildLiveSessionSummaryRecord(
            snapshot,
            sessionScoreProgression(snapshot.events),
            recap,
          );
        } catch (error) {
          violations.push(`S1:build_threw(${kind}): ${String(error)}`);
        }
        let back: LiveSessionSummaryRecordV1 | null = null;
        if (record) {
          const json = JSON.stringify(record);
          back = parseLiveSessionSummaryRecord(json);
          if (back === null)
            violations.push(`S5:built_record_unparseable(${kind})`);
          else {
            const builtViolations = recordViolations(kind, record);
            // The BUILT record may legitimately carry the malformed value
            // (it mirrors the snapshot); what matters is that the PARSED
            // record is valid and that valid fields survive the round trip.
            violations.push(
              ...recordViolations(kind, back).map(v => `${v} [after_parse]`),
            );
            if (kind === 'durationMs=fractional') {
              // In-memory the record legitimately carries 61234.5 (durationMs is
              // a plain number on the write side); what must survive is the value.
              if (
                record.durationMs === 61_234.5 &&
                back.durationMs !== 61_234.5
              ) {
                violations.push(
                  `S5:roundtrip_durationMs_zeroed(${kind}) built=${record.durationMs} back=${back.durationMs}`,
                );
              }
            } else if (
              builtViolations.length === 0 &&
              canonicalJson(back) !== canonicalJson(record)
            ) {
              violations.push(
                `S5:roundtrip_mismatch(${kind}) built=${canonicalJson(record)} back=${canonicalJson(back)}`,
              );
            }
          }
        }
        const outcome: SeedOutcome = {
          seed: -(100 + index),
          outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
          iterations: 1,
          faultsInjected: [`snapshot:${kind}`],
          violations,
          detail: {
            built: record ? canonicalJson(record) : null,
            back: back ? canonicalJson(back) : null,
          },
        };
        outcomes.push(outcome);
        assertSeedOutcome(
          SUITE,
          outcome,
          KNOWN_BROKEN,
          `npx jest --ci ${SUITE} -t "${kind}"`,
        );
      });
    },
  );

  it.failing(
    'MINIMIZED (LSS-1, expected-fail): a fractional durationMs (61234.5) must survive build → JSON → parse',
    () => {
      const snapshot = snapshotOf('min-fractional', [], {
        phase: 'ended',
        durationMs: 61_234.5,
        strokeCount: 0,
      });
      const record = buildLiveSessionSummaryRecord(
        snapshot,
        sessionScoreProgression([]),
        null,
      );
      const back = parseLiveSessionSummaryRecord(JSON.stringify(record));
      expect(record.durationMs).toBe(61_234.5);
      expect(back?.durationMs).toBe(61_234.5);
    },
  );

  it('buildGameplayProgression over 2 000 corrupt + valid rows never throws and counts exactly the parseable live rows (S6)', () => {
    const rng = mulberry32(0x7000);
    const violations: string[] = [];
    const rows = Array.from({ length: 2_000 }, (_, i) => {
      const payload = makePayload(rng, i);
      return {
        id: `row-${i}`,
        startedAt: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
        endedAt: null,
        summary: rng.chance(0.03) ? null : payload.json,
      };
    });
    const expectedLive = rows.filter(row => {
      const parsed = parseLiveSessionSummaryRecord(row.summary);
      return parsed !== null && parsed.source === 'live';
    }).length;
    let progression: ReturnType<typeof buildGameplayProgression> | null = null;
    try {
      progression = buildGameplayProgression(rows);
    } catch (error) {
      violations.push(`S6:progression_threw: ${String(error)}`);
    }
    if (progression) {
      if (progression.sessions.length !== expectedLive) {
        violations.push(
          `S6:session_count=${progression.sessions.length}!=${expectedLive}`,
        );
      }
      for (const key of [
        'totalScoredSwings',
        'totalStrokeEvents',
        'improvedSessions',
      ] as const) {
        if (!isCount(progression[key]))
          violations.push(`S6:${key}=${String(progression[key])}`);
      }
      for (const key of [
        'firstAverage',
        'latestAverage',
        'overallDelta',
      ] as const) {
        if (!isFiniteOrNull(progression[key]))
          violations.push(`S6:${key}=${String(progression[key])}`);
      }
      for (const point of progression.trendPoints) {
        if (!Number.isFinite(point))
          violations.push(`S6:trendPoint=${String(point)}`);
      }
    }
    const outcome: SeedOutcome = {
      seed: -2,
      outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
      iterations: rows.length,
      faultsInjected: [
        'sqlite.summary_row:mixed_corruption',
        'sqlite.summary_row:null',
      ],
      violations,
      detail: { expectedLive, sessions: progression?.sessions.length ?? null },
    };
    outcomes.push(outcome);
    assertSeedOutcome(SUITE, outcome, KNOWN_BROKEN);
    expect(outcome.outcome).toBe('HELD');
  });

  describe('SQLite (LocalDb.execute) faults on listLiveSessionHistory (S7)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const ROW_SHAPES: readonly RowShape[] = [
      'healthy',
      'missing_columns',
      'summary_number',
      'summary_object',
      'id_null',
      'row_null',
    ];

    it.each(FAULT_MODES.map((m, i) => [m, i] as const))(
      'execute() %s → the caller sees the failure or a validated history, never fake success',
      async (mode, index) => {
        const rng = mulberry32(0x8000 + index);
        const violations: string[] = [];
        const rows = fakeRows(rng, 'healthy', 25);
        const db = faultyDb(mode, rows);
        const state: {
          settled: 'resolved' | 'rejected' | 'pending';
          value: unknown;
          error: unknown;
        } = {
          settled: 'pending',
          value: null,
          error: null,
        };
        const call = listLiveSessionHistory(db).then(
          v => {
            state.settled = 'resolved';
            state.value = v;
          },
          e => {
            state.settled = 'rejected';
            state.error = e;
          },
        );
        await jest.advanceTimersByTimeAsync(WATCHDOG_MS);
        const afterWatchdog = state.settled;
        if (mode === 'timeout') await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
        if (mode !== 'never') await jest.advanceTimersByTimeAsync(SLOW_MS);
        if (mode !== 'never') await call;

        switch (mode) {
          case 'none':
          case 'slow':
            if (state.settled !== 'resolved')
              violations.push(
                `S7:healthy_query_not_resolved(${mode})=${state.settled}`,
              );
            else if ((state.value as unknown[]).length !== rows.length)
              violations.push(`S7:row_count(${mode})`);
            if (mode === 'slow' && afterWatchdog !== 'resolved')
              violations.push(`S7:slow_not_resolved_by_60s`);
            break;
          case 'throw':
          case 'reject':
            if (state.settled !== 'rejected')
              violations.push(
                `S7:fault_swallowed(${mode})=${state.settled} value=${JSON.stringify(state.value)}`,
              );
            else if (!(state.error instanceof InjectedFault))
              violations.push(
                `S7:fault_replaced(${mode}): ${String(state.error)}`,
              );
            break;
          case 'timeout':
            // The query answers after 90 s. The repository imposes no deadline
            // of its own (recorded in `detail`); what must hold is that the
            // late answer is still a validated history, not a fake one.
            if (afterWatchdog !== 'pending')
              violations.push(
                `S7:timeout_settled_early(${mode})=${afterWatchdog}`,
              );
            if (state.settled !== 'resolved')
              violations.push(
                `S7:late_query_not_resolved(${mode})=${state.settled}`,
              );
            else if ((state.value as unknown[]).length !== rows.length)
              violations.push(`S7:row_count(${mode})`);
            break;
          case 'malformed':
          case 'partial':
            // `rows` is not an array → destructuring/.map throws → rejection.
            // Resolving with [] here would be FAKE SUCCESS (an empty history).
            if (state.settled === 'resolved')
              violations.push(
                `S7:malformed_result_set_became_history(${mode})=${JSON.stringify(state.value)}`,
              );
            break;
          case 'never':
            if (state.settled !== 'pending')
              violations.push(`S7:never_settled(${mode})=${state.settled}`);
            break;
        }
        const outcome: SeedOutcome = {
          seed: -(200 + index),
          outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
          iterations: 1,
          faultsInjected: [`sqlite.execute:${mode}`],
          violations,
          detail: {
            settled: state.settled,
            afterWatchdog,
            calls: db.calls,
            error: state.error ? String(state.error) : null,
          },
        };
        outcomes.push(outcome);
        assertSeedOutcome(
          SUITE,
          outcome,
          KNOWN_BROKEN,
          `npx jest --ci ${SUITE} -t "execute() ${mode}"`,
        );
        expect(outcome.outcome).toBe('HELD');
      },
    );

    it.each(ROW_SHAPES.map((s, i) => [s, i] as const))(
      'rows shaped %s → history rows are strings/null and corrupt summaries are excluded downstream',
      async (shape, index) => {
        const rng = mulberry32(0x9000 + index);
        const violations: string[] = [];
        const rows = fakeRows(rng, shape, 40);
        const db = faultyDb('none', rows);
        let history: Awaited<ReturnType<typeof listLiveSessionHistory>> | null =
          null;
        let thrown: unknown = null;
        try {
          history = await listLiveSessionHistory(db);
        } catch (error) {
          thrown = error;
        }
        if (shape === 'row_null') {
          // A null row is a driver contract violation — a throw is the honest
          // outcome; a fabricated history entry is not.
          if (history !== null)
            violations.push(`S7:null_row_became_history_entry`);
        } else if (history === null) {
          violations.push(`S7:list_threw(${shape}): ${String(thrown)}`);
        } else {
          for (const row of history) {
            if (typeof row.id !== 'string')
              violations.push(`S7:id_type(${shape})`);
            if (typeof row.startedAt !== 'string')
              violations.push(`S7:startedAt_type(${shape})`);
            if (row.endedAt !== null && typeof row.endedAt !== 'string')
              violations.push(`S7:endedAt_type(${shape})`);
            if (row.summary !== null && typeof row.summary !== 'string')
              violations.push(`S7:summary_type(${shape})`);
          }
          let progression: ReturnType<typeof buildGameplayProgression> | null =
            null;
          try {
            progression = buildGameplayProgression(history);
          } catch (error) {
            violations.push(`S6:progression_threw(${shape}): ${String(error)}`);
          }
          if (progression) {
            const expectedLive = history.filter(
              r => parseLiveSessionSummaryRecord(r.summary)?.source === 'live',
            ).length;
            if (progression.sessions.length !== expectedLive) {
              violations.push(
                `S6:session_count(${shape})=${progression.sessions.length}!=${expectedLive}`,
              );
            }
            if (
              shape !== 'healthy' &&
              shape !== 'id_null' &&
              progression.sessions.length !== 0
            ) {
              violations.push(
                `S4:corrupt_summary_counted_as_history(${shape})=${progression.sessions.length}`,
              );
            }
          }
        }
        const outcome: SeedOutcome = {
          seed: -(300 + index),
          outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
          iterations: rows.length,
          faultsInjected: [`sqlite.rows:${shape}`],
          violations,
          detail: {
            historyLength: history?.length ?? null,
            thrown: thrown ? String(thrown) : null,
          },
        };
        outcomes.push(outcome);
        assertSeedOutcome(
          SUITE,
          outcome,
          KNOWN_BROKEN,
          `npx jest --ci ${SUITE} -t "rows shaped ${shape}"`,
        );
        expect(outcome.outcome).toBe('HELD');
      },
    );

    it('injects every FaultMode into the SQLite seam', () => {
      const injected = new Set(outcomes.flatMap(o => o.faultsInjected));
      for (const mode of INJECTED_FAULT_MODES)
        expect(injected.has(`sqlite.execute:${mode}`)).toBe(true);
    });
  });

  it('KNOWN_BROKEN classes still reproduce (delete the entry + close the finding when this fails)', () => {
    assertKnownBrokenStillReproduce(SUITE, outcomes, KNOWN_BROKEN);
  });
});
