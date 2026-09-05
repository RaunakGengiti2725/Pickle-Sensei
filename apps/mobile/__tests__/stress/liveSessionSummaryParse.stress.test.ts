/**
 * STRESS · mod-live-court · lens boundary-malformed
 * Target: parseLiveSessionSummaryRecord (apps/mobile/src/flow/liveSessionSummary.ts)
 *
 * Feeds the AsyncStorage-shaped parser malformed JSON text, wrong-typed
 * fields, prototype-pollution keys, numeric poison (NaN / ±Infinity / -0 /
 * overflow), NUL bytes, 64K+ strings (byte vs code-point vs grapheme), path
 * traversal, future schema versions, empty containers and unicode
 * normalization pairs.
 *
 * Invariants (hard):
 *   H1 parse never throws for any string / null input
 *   H2 result is null OR a record satisfying the V1 contract (recordViolations)
 *   H3 Object.prototype is never polluted
 *   H4 a well-formed record round-trips (build → serialize → parse) losslessly
 *
 * Soft observations (tabulated, not asserted): accepted-but-out-of-range
 * values (negative scores, >10 scores, -0, unbounded strings, non-checkpoint
 * keys). See the JSON table `artifacts/stress/<run>/summary-parse.json`.
 *
 * KNOWN FINDING F1 (reproduced by this campaign, pinned below as
 * `test.failing` per repo convention — flip it to `test` once fixed):
 *   `String(record.engineVersion ?? 'unknown')` throws TypeError when the
 *   stored `engineVersion` is an object without a callable toString/valueOf
 *   (e.g. `{"toString":1}`), violating the parser's documented
 *   "anything malformed returns null" contract. Rows carrying that exact
 *   signature are tabulated as `BROKEN:F1_engineVersion_object_throw` and
 *   excluded from the hard-failure assertion so the campaign keeps running.
 *
 * Campaign size: STRESS_ITER (default 300). Replay one seed: STRESS_SEED=<n>.
 */
import { parseLiveSessionSummaryRecord } from '../../src/flow/liveSessionSummary';
import {
  JSON_MALFORMATIONS,
  RECORD_MUTATIONS,
  campaignSeeds,
  chance,
  describeError,
  malformJsonText,
  mutateRecord,
  objectPrototypePolluted,
  pick,
  preview,
  recordSoftObservations,
  recordViolations,
  replayCommand,
  seededRandom,
  stressIterations,
  stringCoercionThrows,
  validSummaryRecord,
  writeStressTable,
  type StressRow,
} from '../../testing/stress/liveCourtBoundary';

const SUITE = '__tests__/stress/liveSessionSummaryParse.stress.test.ts';
const ITER = stressIterations(300);

type Family =
  | 'valid_roundtrip'
  | 'json_malformed'
  | 'record_mutated'
  | 'record_mutated_x3'
  | 'raw_poison_text';

function chooseFamily(rng: () => number): Family {
  const roll = rng();
  if (roll < 0.12) return 'valid_roundtrip';
  if (roll < 0.42) return 'json_malformed';
  if (roll < 0.72) return 'record_mutated';
  if (roll < 0.9) return 'record_mutated_x3';
  return 'raw_poison_text';
}

function serialize(value: unknown): string {
  // Non-finite numbers serialize as null via JSON.stringify — that is the
  // exact bytes AsyncStorage would hold, which is what we want to test.
  return JSON.stringify(value);
}

interface Outcome {
  row: StressRow;
  hardFailure: string | null;
}

/** Exact signature of finding F1: valid V1 envelope, object-typed
 * engineVersion with no callable toString/valueOf, TypeError from String(). */
function isKnownF1(input: string | null, error: unknown): boolean {
  if (input === null || !(error instanceof TypeError)) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    return false;
  }
  if (typeof raw !== 'object' || raw === null) return false;
  const record = raw as Record<string, unknown>;
  return (
    record['version'] === 1 &&
    (record['source'] === 'live' || record['source'] === 'replay') &&
    stringCoercionThrows(record['engineVersion'])
  );
}

function runSeed(seed: number): Outcome {
  const rng = seededRandom(seed);
  const family = chooseFamily(rng);
  let input: string | null = null;
  let detail = '';
  const base = validSummaryRecord(rng);

  switch (family) {
    case 'valid_roundtrip':
      input = serialize(base);
      break;
    case 'json_malformed': {
      const kind = pick(rng, JSON_MALFORMATIONS);
      detail = kind;
      input = malformJsonText(rng, serialize(base), kind);
      break;
    }
    case 'record_mutated': {
      const mutation = pick(rng, RECORD_MUTATIONS);
      detail = mutation;
      input = serialize(mutateRecord(rng, base, mutation));
      break;
    }
    case 'record_mutated_x3': {
      let current: Record<string, unknown> = { ...base };
      const applied: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const mutation = pick(rng, RECORD_MUTATIONS);
        applied.push(mutation);
        current = mutateRecord(
          rng,
          current as unknown as ReturnType<typeof validSummaryRecord>,
          mutation,
        );
      }
      detail = applied.join('+');
      input = serialize(current);
      break;
    }
    case 'raw_poison_text':
      input = chance(rng, 0.1)
        ? null
        : pick(rng, [
            '{}',
            '[]',
            '{"version":1}',
            '{"version":1,"source":"live"}',
            '{"version":1,"source":"replay","correctionsByCheckpoint":[]}',
            '{"version":1,"source":"live","__proto__":{"polluted":"yes"}}',
            '{"version":1,"source":"live","constructor":{"prototype":{"polluted":"yes"}}}',
            '{"version":1,"source":"live","correctionsByCheckpoint":{"__proto__":{"polluted":"yes"}}}',
            '{"version":1,"source":"live","correctionsByCheckpoint":{"__proto__":1}}',
            '{"version":1,"source":"live","engineVersion":{"toString":1}}',
            '{"version":1,"source":"live","engineVersion":["a","b"]}',
            '{"version":1,"source":"live","durationMs":1e999}',
            '{"version":1,"source":"live","durationMs":-0,"bestScore":-0}',
            '{"version":1,"source":"live","bestScore":1e308,"delta":-1e308}',
            '{"version":1,"source":"live","topCorrection":"../../etc/passwd"}',
            `{"version":1,"source":"live","topCorrection":"${'x'.repeat(70000)}"}`,
            `{"version":1,"source":"live","engineVersion":"${'\\u0000'.repeat(64)}"}`,
            '{"version":1,"source":"live\\u0000"}',
            '{"version":1.0,"source":"live"}',
            '{"version":"1","source":"live"}',
            '{"version":2,"source":"live"}',
            '{"version":true,"source":"live"}',
            '{"version":1,"source":"LIVE"}',
            '{"version":1,"source":"live","source":"bogus"}',
            '{"source":"bogus","version":1,"source":"live"}',
            'null',
            'true',
            '0',
            '"live"',
            '',
            '\uFEFF{"version":1,"source":"live"}',
          ]);
      detail = input === null ? 'null-storage' : 'literal';
      break;
  }

  const hadPollution = objectPrototypePolluted();
  let outcome: string;
  let hardFailure: string | null = null;
  let soft: string[] = [];

  try {
    const parsed = parseLiveSessionSummaryRecord(input);
    if (parsed === null) {
      outcome = 'HELD:rejected_null';
    } else {
      const violations = recordViolations(parsed);
      if (violations.length > 0) {
        outcome = 'BROKEN:contract_violation';
        hardFailure = `H2 contract violations: ${violations.join(', ')}`;
      } else {
        soft = recordSoftObservations(parsed);
        outcome = soft.length ? 'HELD:accepted_out_of_range' : 'HELD:accepted';
      }
      if (family === 'valid_roundtrip') {
        const again = parseLiveSessionSummaryRecord(serialize(parsed));
        if (JSON.stringify(again) !== JSON.stringify(base)) {
          outcome = 'BROKEN:roundtrip_lossy';
          hardFailure = `H4 round-trip mismatch: ${preview(again)} vs ${preview(base)}`;
        }
      }
    }
  } catch (error) {
    if (isKnownF1(input, error)) {
      outcome = 'BROKEN:F1_engineVersion_object_throw';
    } else {
      outcome = 'BROKEN:throw';
      hardFailure = `H1 threw ${describeError(error)}`;
    }
  }

  if (!hadPollution && objectPrototypePolluted()) {
    outcome = 'BROKEN:prototype_polluted';
    hardFailure = 'H3 Object.prototype polluted';
  }

  return {
    row: {
      seed,
      family,
      outcome,
      detail: [detail, ...soft].filter(Boolean).join(' | '),
      input: preview(input),
    },
    hardFailure,
  };
}

describe('stress · liveSessionSummary parser · boundary-malformed', () => {
  const seeds = campaignSeeds('summary-parse', ITER);

  test(`H1–H4 hold across ${seeds.length} seeded malformed inputs`, () => {
    const rows: StressRow[] = [];
    const failures: string[] = [];
    for (const seed of seeds) {
      const { row, hardFailure } = runSeed(seed);
      rows.push(row);
      if (hardFailure) {
        failures.push(
          `seed=${seed} [${row.family}/${row.detail}] ${hardFailure}\n  replay: ${replayCommand(SUITE, seed)}`,
        );
      }
    }
    const table = writeStressTable(SUITE, 'summary-parse', rows);
    expect(table.iterations).toBe(seeds.length);
    expect(failures).toEqual([]);
    // The campaign must actually exercise rejection AND acceptance paths.
    expect(table.outcomes['HELD:rejected_null'] ?? 0).toBeGreaterThan(0);
    expect(
      (table.outcomes['HELD:accepted'] ?? 0) +
        (table.outcomes['HELD:accepted_out_of_range'] ?? 0),
    ).toBeGreaterThan(0);
  });

  test('deterministic replay: same seed → identical row', () => {
    const seed = seeds[0];
    if (seed === undefined) throw new Error('no seeds');
    expect(runSeed(seed)).toEqual(runSeed(seed));
  });

  test('Object.prototype is clean after the campaign', () => {
    expect(objectPrototypePolluted()).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  // F1 minimized reproduction. Expected behaviour: null (reject). Observed:
  // TypeError "Cannot convert object to primitive value" escapes the parser.
  test.failing(
    'F1: object-typed engineVersion without callable toString returns null instead of throwing',
    () => {
      const stored =
        '{"version":1,"source":"live","engineVersion":{"toString":1}}';
      let result: unknown = 'not-run';
      expect(() => {
        result = parseLiveSessionSummaryRecord(stored);
      }).not.toThrow();
      expect(result).toBeNull();
    },
  );

  test('F1 companion: non-throwing object engineVersion is coerced, not rejected (documents current behaviour)', () => {
    const record = parseLiveSessionSummaryRecord(
      '{"version":1,"source":"live","engineVersion":{}}',
    );
    expect(record?.engineVersion).toBe('[object Object]');
    const list = parseLiveSessionSummaryRecord(
      '{"version":1,"source":"live","engineVersion":["a","b"]}',
    );
    expect(list?.engineVersion).toBe('a,b');
  });
});
