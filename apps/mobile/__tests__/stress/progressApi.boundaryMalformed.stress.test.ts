import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ApiSession } from '../../src/account/apiSession';
import {
  fetchCanonicalProgress,
  ProgressApiError,
  type CanonicalProgress,
  type ProgressFetch,
} from '../../src/progress/api';

/**
 * Seeded boundary/malformed-input campaign for `fetchCanonicalProgress` —
 * the ONE place server JSON becomes `CanonicalProgress`.
 *
 * Every iteration is replayable from its seed:
 *   STRESS_ITER=<n>        iterations (default 200; the campaign run uses 1500)
 *   STRESS_SEED=<base>     base seed (default 0x50524f47)
 *   STRESS_REPLAY=<s1,s2>  run exactly these iteration seeds
 *   STRESS_OUT=<dir>       write the seed → outcome JSON table there
 *
 * Oracle: an independent STRICT reading of the wire contract (a numeric field
 * is a finite JSON number or a Postgres numeric text like "76.0"; a string
 * field is a string; `practicedToday` is a boolean; `lastPracticeDate` is a
 * string or null). Each iteration is classified:
 *   ok               strict accepts, impl resolves with the identical value
 *   rejected         strict rejects, impl throws ProgressApiError
 *   lenient_type     strict rejects (wrong JSON type), impl RESOLVES (coerced)
 *   lenient_string   strict rejects (non-numeric text), impl RESOLVES
 *   mismatch         both accept, values differ
 *   over_reject      strict accepts, impl throws ProgressApiError
 *   escaped_error    impl throws something that is not ProgressApiError
 */

const ITERATIONS = Number.parseInt(process.env.STRESS_ITER ?? '', 10) || 200;
const BASE_SEED =
  Number.parseInt(process.env.STRESS_SEED ?? '', 10) || 0x50524f47;
const REPLAY = (process.env.STRESS_REPLAY ?? '')
  .split(',')
  .map(part => Number.parseInt(part, 10))
  .filter(seed => Number.isFinite(seed));
const OUT_DIR = process.env.STRESS_OUT;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function iterationSeeds(): number[] {
  if (REPLAY.length > 0) return REPLAY;
  return Array.from(
    { length: ITERATIONS },
    (_, index) => (BASE_SEED + index * 0x9e3779b9) >>> 0,
  );
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  range(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }
  chance(probability: number): boolean {
    return this.next() < probability;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
}

// ---------------------------------------------------------------------------
// JSON text model: objects are ordered entry lists (duplicate keys allowed)
// and `Raw` injects tokens JSON.stringify cannot produce (-0, 1e400, …).
// ---------------------------------------------------------------------------

class Raw {
  constructor(readonly text: string) {}
}
class Obj {
  constructor(readonly entries: Array<[string, Node]>) {}
  get(key: string): Node | undefined {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry && entry[0] === key) return entry[1];
    }
    return undefined;
  }
  set(key: string, value: Node): void {
    const index = this.entries.findIndex(entry => entry[0] === key);
    if (index === -1) this.entries.push([key, value]);
    else this.entries[index] = [key, value];
  }
  delete(key: string): void {
    const index = this.entries.findIndex(entry => entry[0] === key);
    if (index !== -1) this.entries.splice(index, 1);
  }
}
type Node = null | boolean | number | string | Node[] | Obj | Raw;

function serialize(node: Node): string {
  if (node instanceof Raw) return node.text;
  if (node instanceof Obj) {
    return `{${node.entries
      .map(([key, value]) => `${JSON.stringify(key)}:${serialize(value)}`)
      .join(',')}}`;
  }
  if (Array.isArray(node)) return `[${node.map(serialize).join(',')}]`;
  return JSON.stringify(node);
}

// ---------------------------------------------------------------------------
// Value pools
// ---------------------------------------------------------------------------

const CHECKPOINTS = [
  'ready_position',
  'athletic_base',
  'preparation',
  'contact_position',
  'face_wrist_stability',
  'follow_through',
  'recovery',
];
const SHOT_TYPES = [
  'forehand_drive',
  'backhand_drive',
  'dink',
  'serve',
  'volley',
];

const NFC_NFD_PAIRS: Array<[string, string]> = [
  ['\u00e9', 'e\u0301'],
  ['\u00f1', 'n\u0303'],
  ['\u1e69', 's\u0323\u0307'],
  ['\uac00', '\u1100\u1161'],
  ['\ufb01', 'fi'],
  ['\u212b', '\u00c5'],
];

const HOSTILE_STRINGS = [
  '',
  ' ',
  '\u0000',
  'a\u0000b',
  '../../../etc/passwd',
  '..\\..\\windows\\system32',
  '/v1/progress/../../admin',
  '%2e%2e%2f%2e%2e%2f',
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'hasOwnProperty',
  '<script>alert(1)</script>',
  "'; DROP TABLE shots; --",
  '\u202e\u0644\u0627\u0645',
  '\ud83d\udc4b\ud83c\udffd',
  '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67',
  '\ufeffforehand_drive',
  'forehand_drive\r\n',
  'NaN',
  'Infinity',
  '-Infinity',
  'null',
  'undefined',
  '[object Object]',
  '9'.repeat(400),
  '\uffff'.repeat(64),
];

function hugeString(rng: Rng): string {
  const unit = rng.pick(['a', '\u00e9', '\ud83d\udc4b', '\u0000', 'x\u0301']);
  const chars = rng.chance(0.05) ? 1_048_576 : 65_536 + rng.int(512);
  return unit.repeat(Math.ceil(chars / unit.length));
}

function hostileString(rng: Rng): string {
  const roll = rng.float();
  if (roll < 0.1) return hugeString(rng);
  if (roll < 0.3) {
    const pair = rng.pick(NFC_NFD_PAIRS);
    return rng.chance(0.5) ? pair[0] : pair[1];
  }
  return rng.pick(HOSTILE_STRINGS);
}

/** Numeric texts Postgres emits for numeric/bigint columns. */
function numericText(rng: Rng, value: number): string {
  if (Number.isInteger(value) && rng.chance(0.5)) return String(value);
  return value.toFixed(rng.range(1, 4));
}

/** JSON values that are NOT numbers and NOT numeric text. */
function wrongTypeNumeric(rng: Rng): Node {
  return rng.pick<Node>([
    null,
    true,
    false,
    [],
    [5],
    [[]],
    [1, 2],
    new Obj([]),
    new Obj([['value', 5]]),
    new Obj([['__proto__', new Obj([['polluted', true]])]]),
    '',
    ' ',
    '\t\n',
    '\u0000',
    'NaN',
    'Infinity',
    '-Infinity',
    'abc',
    'null',
    'undefined',
    '[object Object]',
    '\u0661\u0662',
    '\uff11\uff12',
  ]);
}

/** Strings a lenient Number() accepts but Postgres never emits. */
function lenientNumericString(rng: Rng): string {
  return rng.pick([
    ' 12 ',
    '0x1A',
    '0b101',
    '0o17',
    '1e3',
    '1E-2',
    '.5',
    '5.',
    '+7',
    '1_000',
    '12\n',
    '\u00a012',
    '1e400',
    '-1e400',
  ]);
}

/** Raw JSON number tokens at the numeric boundary. */
function boundaryNumber(rng: Rng): Raw {
  return new Raw(
    rng.pick([
      '-0',
      '0',
      '1e400',
      '-1e400',
      '1e-400',
      '1.7976931348623157e308',
      '5e-324',
      '9007199254740993',
      '-9007199254740993',
      '123456789012345678901234567890',
      '0.1',
      '1e21',
      '1E+2',
      '-1',
      '2147483648',
      '4294967296',
      '18446744073709551616',
    ]),
  );
}

// ---------------------------------------------------------------------------
// Base payload + strict oracle
// ---------------------------------------------------------------------------

function baseSeriesRow(rng: Rng): Obj {
  const shotCount = rng.range(1, 200);
  const avg = rng.range(0, 1000) / 10;
  const best = rng.range(0, 1000) / 10;
  return new Obj([
    [
      'day',
      `2026-0${rng.range(1, 9)}-${String(rng.range(1, 28)).padStart(2, '0')}`,
    ],
    ['shot_type', rng.pick(SHOT_TYPES)],
    ['scoring_model_version', `sm-v${rng.range(1, 9)}`],
    ['shot_count', rng.chance(0.5) ? shotCount : numericText(rng, shotCount)],
    ['avg_score', rng.chance(0.5) ? avg : numericText(rng, avg)],
    ['best_score', rng.chance(0.5) ? best : numericText(rng, best)],
  ]);
}

function baseTrendRow(rng: Rng, key: 'delta' | 'avg'): Obj {
  const value =
    key === 'delta' ? rng.range(-500, 500) / 10 : rng.range(0, 1000) / 10;
  return new Obj([
    ['checkpoint', rng.pick(CHECKPOINTS)],
    [key, rng.chance(0.5) ? value : numericText(rng, value)],
  ]);
}

function basePayload(rng: Rng): Obj {
  const seriesLength = rng.chance(0.02) ? rng.range(500, 3000) : rng.int(6);
  const series: Node[] = [];
  for (let index = 0; index < seriesLength; index += 1) {
    series.push(baseSeriesRow(rng));
  }
  const improving: Node[] = [];
  for (let index = rng.int(4); index > 0; index -= 1) {
    improving.push(baseTrendRow(rng, 'delta'));
  }
  const needsAttention: Node[] = [];
  for (let index = rng.int(4); index > 0; index -= 1) {
    needsAttention.push(baseTrendRow(rng, 'avg'));
  }
  const currentDays = rng.range(0, 400);
  return new Obj([
    ['series', series],
    ['improving', improving],
    ['needsAttention', needsAttention],
    [
      'streak',
      new Obj([
        ['currentDays', rng.chance(0.5) ? currentDays : String(currentDays)],
        ['longestDays', rng.range(0, 4000)],
        ['practicedToday', rng.chance(0.5)],
        ['lastPracticeDate', rng.chance(0.2) ? null : '2026-08-27'],
      ]),
    ],
  ]);
}

const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;

type Strict =
  | { kind: 'ok'; value: CanonicalProgress }
  | { kind: 'reject'; reason: string; wrongType: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class StrictReject extends Error {
  constructor(
    reason: string,
    readonly wrongType: boolean,
  ) {
    super(reason);
  }
}

function strictNumber(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new StrictReject(`${field}: non-finite`, false);
    return value;
  }
  if (typeof value === 'string') {
    if (!NUMERIC_TEXT.test(value)) {
      throw new StrictReject(
        `${field}: non-numeric text`,
        value.trim() === '' || /^(NaN|-?Infinity|null|undefined)$/.test(value),
      );
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
      throw new StrictReject(`${field}: non-finite text`, false);
    return parsed;
  }
  throw new StrictReject(
    `${field}: ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`,
    true,
  );
}

function strictString(value: unknown, field: string): string {
  if (typeof value !== 'string')
    throw new StrictReject(`${field}: not a string`, true);
  return value;
}

/** Independent strict reading of the /v1/progress wire contract. */
function strictExpectation(payload: unknown): Strict {
  try {
    if (
      !isRecord(payload) ||
      !Array.isArray(payload['series']) ||
      !Array.isArray(payload['improving']) ||
      !Array.isArray(payload['needsAttention']) ||
      !isRecord(payload['streak'])
    ) {
      throw new StrictReject('shape', true);
    }
    const series = payload['series'].map((row: unknown) => {
      if (!isRecord(row)) throw new StrictReject('series row', true);
      return {
        day: strictString(row['day'], 'day'),
        shotType: strictString(row['shot_type'], 'shot_type'),
        scoringModelVersion: strictString(
          row['scoring_model_version'],
          'scoring_model_version',
        ),
        shotCount: strictNumber(row['shot_count'], 'shot_count'),
        avgScore: strictNumber(row['avg_score'], 'avg_score') / 10,
        bestScore: strictNumber(row['best_score'], 'best_score') / 10,
      };
    });
    const improving = payload['improving'].map((row: unknown) => {
      if (!isRecord(row)) throw new StrictReject('improving row', true);
      return {
        checkpoint: strictString(row['checkpoint'], 'checkpoint'),
        delta: strictNumber(row['delta'], 'delta'),
      };
    });
    const needsAttention = payload['needsAttention'].map((row: unknown) => {
      if (!isRecord(row)) throw new StrictReject('needsAttention row', true);
      return {
        checkpoint: strictString(row['checkpoint'], 'checkpoint'),
        avg: strictNumber(row['avg'], 'avg'),
      };
    });
    const streak = payload['streak'];
    const practicedToday = streak['practicedToday'];
    if (typeof practicedToday !== 'boolean') {
      throw new StrictReject('practicedToday', true);
    }
    const lastPracticeDate = streak['lastPracticeDate'];
    if (lastPracticeDate !== null && typeof lastPracticeDate !== 'string') {
      throw new StrictReject('lastPracticeDate', true);
    }
    return {
      kind: 'ok',
      value: {
        series,
        improving,
        needsAttention,
        streak: {
          currentDays: strictNumber(streak['currentDays'], 'currentDays'),
          longestDays: strictNumber(streak['longestDays'], 'longestDays'),
          practicedToday,
          lastPracticeDate,
        },
      },
    };
  } catch (error) {
    if (error instanceof StrictReject) {
      return {
        kind: 'reject',
        reason: error.message,
        wrongType: error.wrongType,
      };
    }
    throw error;
  }
}

/** Object.is-based deep equality (so -0 and 0 are told apart). */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      sameValue(leftKeys, rightKeys) &&
      leftKeys.every(key => sameValue(left[key], right[key]))
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const SERIES_NUMERIC_FIELDS = [
  'shot_count',
  'avg_score',
  'best_score',
] as const;
const SERIES_STRING_FIELDS = [
  'day',
  'shot_type',
  'scoring_model_version',
] as const;
const STREAK_NUMERIC_FIELDS = ['currentDays', 'longestDays'] as const;
const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

interface Scenario {
  mutation: string;
  bodyText: string;
  status: number;
  transport: 'body' | 'empty-body' | 'stream-error' | 'network-reject';
}

function pickRow(rng: Rng, payload: Obj, key: string): Obj | null {
  const rows = payload.get(key);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rng.pick(rows);
  return row instanceof Obj ? row : null;
}

function ensureRow(rng: Rng, payload: Obj, key: string): Obj {
  const existing = pickRow(rng, payload, key);
  if (existing) return existing;
  const row =
    key === 'series'
      ? baseSeriesRow(rng)
      : baseTrendRow(rng, key === 'improving' ? 'delta' : 'avg');
  const rows = payload.get(key);
  if (Array.isArray(rows)) rows.push(row);
  else payload.set(key, [row]);
  return row;
}

function mutate(rng: Rng, payload: Obj): string {
  // A second mutation may follow one that replaced or removed `streak`; the
  // streak-targeted cases then re-install a well-formed streak first (the
  // oracle reads the final text, so the label stays honest).
  const existingStreak = payload.get('streak');
  const streak =
    existingStreak instanceof Obj
      ? existingStreak
      : new Obj([
          ['currentDays', rng.range(0, 30)],
          ['longestDays', rng.range(0, 60)],
          ['practicedToday', false],
          ['lastPracticeDate', null],
        ]);
  const reinstallStreak = (): void => {
    if (!(existingStreak instanceof Obj)) payload.set('streak', streak);
  };
  const choice = rng.int(26);
  switch (choice) {
    case 0:
      return 'valid';
    case 1: {
      const row = ensureRow(rng, payload, 'series');
      row.set(rng.pick(SERIES_NUMERIC_FIELDS), wrongTypeNumeric(rng));
      return 'series.numeric.wrongType';
    }
    case 2: {
      const row = ensureRow(rng, payload, 'series');
      row.set(rng.pick(SERIES_NUMERIC_FIELDS), lenientNumericString(rng));
      return 'series.numeric.lenientString';
    }
    case 3: {
      const row = ensureRow(rng, payload, 'series');
      row.set(rng.pick(SERIES_NUMERIC_FIELDS), boundaryNumber(rng));
      return 'series.numeric.boundaryToken';
    }
    case 4: {
      const row = ensureRow(rng, payload, 'series');
      row.set(rng.pick(SERIES_STRING_FIELDS), hostileString(rng));
      return 'series.string.hostile';
    }
    case 5: {
      const row = ensureRow(rng, payload, 'series');
      row.set(
        rng.pick(SERIES_STRING_FIELDS),
        rng.pick<Node>([null, 7, true, [], new Obj([]), ['a'], -0]),
      );
      return 'series.string.wrongType';
    }
    case 6: {
      const row = ensureRow(rng, payload, 'series');
      row.delete(rng.pick([...SERIES_NUMERIC_FIELDS, ...SERIES_STRING_FIELDS]));
      return 'series.missingField';
    }
    case 7: {
      const rows = payload.get('series');
      if (Array.isArray(rows)) {
        rows.push(
          rng.pick<Node>([null, 1, 'row', [], [[]], true, new Raw('-0')]),
        );
      }
      return 'series.nonObjectRow';
    }
    case 8: {
      const key = rng.pick(['improving', 'needsAttention'] as const);
      const row = ensureRow(rng, payload, key);
      row.set(key === 'improving' ? 'delta' : 'avg', wrongTypeNumeric(rng));
      return `${key}.numeric.wrongType`;
    }
    case 9: {
      const key = rng.pick(['improving', 'needsAttention'] as const);
      const row = ensureRow(rng, payload, key);
      row.set(key === 'improving' ? 'delta' : 'avg', boundaryNumber(rng));
      return `${key}.numeric.boundaryToken`;
    }
    case 10: {
      const key = rng.pick(['improving', 'needsAttention'] as const);
      const row = ensureRow(rng, payload, key);
      row.set('checkpoint', hostileString(rng));
      return `${key}.checkpoint.hostile`;
    }
    case 11: {
      const key = rng.pick(['improving', 'needsAttention'] as const);
      const row = ensureRow(rng, payload, key);
      // The other trend's key: a swapped column name must not be accepted.
      row.delete(key === 'improving' ? 'delta' : 'avg');
      row.set(key === 'improving' ? 'avg' : 'delta', 3.5);
      return `${key}.swappedValueKey`;
    }
    case 12: {
      reinstallStreak();
      streak.set(rng.pick(STREAK_NUMERIC_FIELDS), wrongTypeNumeric(rng));
      return 'streak.numeric.wrongType';
    }
    case 13: {
      reinstallStreak();
      streak.set(rng.pick(STREAK_NUMERIC_FIELDS), boundaryNumber(rng));
      return 'streak.numeric.boundaryToken';
    }
    case 14: {
      reinstallStreak();
      streak.set(
        'practicedToday',
        rng.pick<Node>([
          null,
          0,
          1,
          'true',
          'false',
          'yes',
          [],
          new Obj([]),
          new Raw('-0'),
        ]),
      );
      return 'streak.practicedToday.wrongType';
    }
    case 15: {
      reinstallStreak();
      streak.set(
        'lastPracticeDate',
        rng.pick<Node>([
          0,
          20260827,
          true,
          [],
          new Obj([]),
          ['2026-08-27'],
          new Raw('-0'),
        ]),
      );
      return 'streak.lastPracticeDate.wrongType';
    }
    case 16: {
      reinstallStreak();
      streak.set('lastPracticeDate', hostileString(rng));
      return 'streak.lastPracticeDate.hostile';
    }
    case 17: {
      const key = rng.pick([
        'series',
        'improving',
        'needsAttention',
        'streak',
      ] as const);
      payload.set(
        key,
        rng.pick<Node>([
          null,
          'x',
          0,
          true,
          new Obj([]),
          [],
          new Raw('-0'),
          'null',
        ]),
      );
      if (key === 'streak' && payload.get('streak') instanceof Obj) {
        return 'topLevel.streak.emptyObject';
      }
      return `topLevel.${key}.wrongType`;
    }
    case 18: {
      payload.delete(
        rng.pick(['series', 'improving', 'needsAttention', 'streak']),
      );
      return 'topLevel.missingField';
    }
    case 19: {
      reinstallStreak();
      const target = rng.pick<Obj>([
        payload,
        streak,
        ensureRow(rng, payload, 'series'),
        ensureRow(rng, payload, rng.pick(['improving', 'needsAttention'])),
      ]);
      const key = rng.pick(PROTO_KEYS);
      target.entries.push([
        key,
        rng.pick<Node>([
          new Obj([['polluted', true]]),
          new Obj([['toString', 'x']]),
          'polluted',
          [1],
          null,
        ]),
      ]);
      return `prototypeKey.${key}`;
    }
    case 20: {
      payload.entries.push(
        [
          'schemaVersion',
          rng.pick<Node>([2, 99, '3.0', new Obj([['major', 9]])]),
        ],
        ['futureField', new Obj([['nested', [1, 2, 3]]])],
      );
      return 'futureSchemaFields';
    }
    case 21: {
      reinstallStreak();
      // Duplicate key: JSON.parse keeps the LAST occurrence.
      const target = rng.pick<Obj>([streak, ensureRow(rng, payload, 'series')]);
      const entry = target.entries[rng.int(target.entries.length)];
      if (entry) {
        const duplicate: Node =
          typeof entry[1] === 'number'
            ? entry[1] + 1
            : typeof entry[1] === 'string'
              ? `${entry[1]}x`
              : entry[1];
        target.entries.push([entry[0], duplicate]);
      }
      return 'duplicateKey';
    }
    case 22: {
      payload.set('series', []);
      payload.set('improving', []);
      payload.set('needsAttention', []);
      return 'emptyArrays';
    }
    case 23: {
      reinstallStreak();
      const row = ensureRow(rng, payload, 'series');
      row.set(rng.pick(SERIES_NUMERIC_FIELDS), new Raw('-0'));
      row.set(rng.pick(SERIES_NUMERIC_FIELDS), new Raw('1e400'));
      streak.set('currentDays', new Raw('-0'));
      return 'mixed.negativeZeroAndOverflow';
    }
    default: {
      const rows = payload.get('series');
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row instanceof Obj && rng.chance(0.5)) {
            row.set(rng.pick(SERIES_NUMERIC_FIELDS), wrongTypeNumeric(rng));
          }
        }
      }
      return 'series.manyRows.wrongType';
    }
  }
}

function corruptText(
  rng: Rng,
  text: string,
): { text: string; mutation: string } {
  const roll = rng.int(8);
  switch (roll) {
    case 0:
      return {
        text: text.slice(0, rng.int(text.length)),
        mutation: 'json.truncated',
      };
    case 1: {
      const at = rng.int(text.length + 1);
      const junk = rng.pick([
        '\u0000',
        '\\',
        '"',
        '{',
        '}',
        ',',
        ':',
        '\ud800',
        '\ufeff',
        'x',
        '\n',
        '\\u00',
      ]);
      return {
        text: `${text.slice(0, at)}${junk}${text.slice(at)}`,
        mutation: 'json.injectedByte',
      };
    }
    case 2:
      return {
        text: `${text}${rng.pick(['}', ']', ',', 'null', '{}', ' garbage', '\u0000'])}`,
        mutation: 'json.trailingGarbage',
      };
    case 3:
      return { text: `\ufeff${text}`, mutation: 'json.bom' };
    case 4:
      return {
        text: rng.pick([
          '',
          ' ',
          'null',
          'undefined',
          'NaN',
          '[]',
          '"str"',
          '0',
          'true',
          '{',
          '[',
          '{"series":',
          "{'series':[]}",
          '<html>502</html>',
          '{"series":[],"improving":[],"needsAttention":[],"streak":{}}',
        ]),
        mutation: 'json.replacedBody',
      };
    case 5: {
      const at = rng.int(text.length);
      return {
        text: `${text.slice(0, at)}${text.slice(at + 1)}`,
        mutation: 'json.deletedByte',
      };
    }
    case 6:
      return { text: text.replace(/"/g, "'"), mutation: 'json.singleQuotes' };
    default:
      return { text: text.replace(/,/g, ',,'), mutation: 'json.doubleCommas' };
  }
}

function buildScenario(seed: number): Scenario {
  const rng = new Rng(seed);
  const payload = basePayload(rng);
  let mutation = mutate(rng, payload);
  if (rng.chance(0.25)) mutation = `${mutation}+${mutate(rng, payload)}`;
  let bodyText = serialize(payload);
  if (rng.chance(0.2)) {
    const corrupted = corruptText(rng, bodyText);
    bodyText = corrupted.text;
    mutation = `${mutation}+${corrupted.mutation}`;
  }
  let status = 200;
  let transport: Scenario['transport'] = 'body';
  const transportRoll = rng.float();
  if (transportRoll < 0.08) {
    status = rng.pick([
      201, 204, 299, 301, 304, 400, 401, 403, 404, 408, 413, 422, 429, 500, 502,
      503, 504, 599,
    ]);
    mutation = `${mutation}+http.${status}`;
  } else if (transportRoll < 0.1) {
    transport = 'empty-body';
    mutation = `${mutation}+transport.emptyBody`;
  } else if (transportRoll < 0.12) {
    transport = 'stream-error';
    mutation = `${mutation}+transport.streamError`;
  } else if (transportRoll < 0.14) {
    transport = 'network-reject';
    mutation = `${mutation}+transport.networkReject`;
  }
  return { mutation, bodyText, status, transport };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'stress-token',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
};

interface Outcome {
  seed: number;
  mutation: string;
  status: number;
  transport: Scenario['transport'];
  bodyBytes: number;
  strict: 'ok' | 'reject' | 'n/a';
  strictReason?: string;
  impl: 'resolved' | 'ProgressApiError' | 'escaped';
  implMessage?: string;
  class:
    | 'ok'
    | 'rejected'
    | 'lenient_type'
    | 'lenient_string'
    | 'mismatch'
    | 'over_reject'
    | 'escaped_error';
  fetchCalls: number;
  method: string | undefined;
  timersLeaked: number;
  prototypePolluted: boolean;
  /** First 160 code units of the body for the table (huge bodies elided). */
  bodyPreview: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** HTTP statuses that cannot carry a body (the fetch spec forbids one). */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

function makeFetch(
  scenario: Scenario,
  calls: Array<{ url: string; init: RequestInit | undefined }>,
): ProgressFetch {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    switch (scenario.transport) {
      case 'network-reject':
        throw new TypeError('Network request failed');
      case 'empty-body':
        return new Response(null, { status: scenario.status });
      case 'stream-error': {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(scenario.bodyText.slice(0, 8)));
            controller.error(new Error('stream reset'));
          },
        });
        // React Native's `BodyInit_` typing omits ReadableStream; Node's
        // undici Response (what jest runs) accepts it.
        return new Response(
          stream as unknown as ConstructorParameters<typeof Response>[0],
          { status: scenario.status },
        );
      }
      default:
        if (NULL_BODY_STATUS.has(scenario.status))
          return new Response(null, { status: scenario.status });
        return new Response(encoder.encode(scenario.bodyText), {
          status: scenario.status,
          headers: { 'content-type': 'application/json' },
        });
    }
  };
}

function protoSnapshot(): string {
  return JSON.stringify([
    Object.getOwnPropertyNames(Object.prototype).sort(),
    Object.getOwnPropertyNames(Array.prototype).sort(),
    Object.getOwnPropertyNames(Function.prototype).sort(),
  ]);
}

async function runScenario(seed: number, scenario: Scenario): Promise<Outcome> {
  const before = protoSnapshot();
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = makeFetch(scenario, calls);

  // Fake timers: the 15s abort timer must be cleared on EVERY path, so the
  // count of live fake timers after the call is the leak detector.
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
  });

  let impl: Outcome['impl'];
  let implMessage: string | undefined;
  let resolved: CanonicalProgress | undefined;
  try {
    resolved = await fetchCanonicalProgress(session, fetchFn);
    impl = 'resolved';
  } catch (error) {
    if (error instanceof ProgressApiError) {
      impl = 'ProgressApiError';
    } else {
      impl = 'escaped';
    }
    implMessage =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  }
  const timersLeaked = jest.getTimerCount();
  jest.clearAllTimers();
  jest.useRealTimers();

  // What the implementation could have seen: the same bytes, decoded.
  let strict: Strict | null = null;
  let strictLabel: Outcome['strict'] = 'n/a';
  const httpOk =
    scenario.status >= 200 &&
    scenario.status <= 299 &&
    !NULL_BODY_STATUS.has(scenario.status);
  if (scenario.transport === 'body' && httpOk) {
    let parsed: unknown = null;
    let parseFailed = false;
    try {
      parsed = JSON.parse(decoder.decode(encoder.encode(scenario.bodyText)));
    } catch {
      parseFailed = true;
    }
    strict = parseFailed
      ? { kind: 'reject', reason: 'unparseable JSON', wrongType: true }
      : strictExpectation(parsed);
    strictLabel = strict.kind;
  } else {
    strict = {
      kind: 'reject',
      reason: `transport ${scenario.transport} / http ${scenario.status}`,
      wrongType: true,
    };
    strictLabel = 'reject';
  }

  let cls: Outcome['class'];
  if (impl === 'escaped') cls = 'escaped_error';
  else if (impl === 'ProgressApiError')
    cls = strict.kind === 'ok' ? 'over_reject' : 'rejected';
  else if (strict.kind === 'ok')
    cls = sameValue(resolved, strict.value) ? 'ok' : 'mismatch';
  else cls = strict.wrongType ? 'lenient_type' : 'lenient_string';

  const after = protoSnapshot();
  const polluted =
    before !== after ||
    ({} as Record<string, unknown>)['polluted'] !== undefined ||
    ([] as unknown as Record<string, unknown>)['polluted'] !== undefined;

  return {
    seed,
    mutation: scenario.mutation,
    status: scenario.status,
    transport: scenario.transport,
    bodyBytes: encoder.encode(scenario.bodyText).byteLength,
    strict: strictLabel,
    strictReason: strict.kind === 'reject' ? strict.reason : undefined,
    impl,
    implMessage,
    class: cls,
    fetchCalls: calls.length,
    method: calls[0]?.init?.method,
    timersLeaked,
    prototypePolluted: polluted,
    bodyPreview:
      scenario.bodyText.length > 160
        ? `${scenario.bodyText.slice(0, 160)}…(${scenario.bodyText.length})`
        : scenario.bodyText,
  };
}

const outcomes: Outcome[] = [];

beforeAll(async () => {
  for (const seed of iterationSeeds()) {
    outcomes.push(await runScenario(seed, buildScenario(seed)));
  }
  if (OUT_DIR) {
    mkdirSync(OUT_DIR, { recursive: true });
    const counts: Record<string, number> = {};
    for (const outcome of outcomes) {
      counts[outcome.class] = (counts[outcome.class] ?? 0) + 1;
    }
    writeFileSync(
      join(OUT_DIR, 'progressApi.boundaryMalformed.json'),
      JSON.stringify(
        {
          unit: 'progress/api.fetchCanonicalProgress',
          lens: 'boundary-malformed',
          baseSeed: BASE_SEED,
          iterations: outcomes.length,
          counts,
          outcomes,
        },
        null,
        2,
      ),
    );
  }
}, 600_000);

function seedsOf(predicate: (outcome: Outcome) => boolean): string[] {
  return outcomes
    .filter(predicate)
    .map(
      outcome =>
        `${outcome.seed}:${outcome.mutation}:${outcome.implMessage ?? outcome.strictReason ?? ''}`,
    );
}

describe('fetchCanonicalProgress boundary/malformed campaign', () => {
  it('ran every scheduled iteration', () => {
    expect(outcomes.length).toBe(iterationSeeds().length);
    expect(outcomes.length).toBeGreaterThan(0);
  });

  it('never lets a non-ProgressApiError escape the handler', () => {
    expect(seedsOf(outcome => outcome.class === 'escaped_error')).toEqual([]);
  });

  it('never mutates Object/Array/Function prototypes from hostile keys', () => {
    expect(seedsOf(outcome => outcome.prototypePolluted)).toEqual([]);
  });

  it('issues exactly one GET and clears its timeout on every path', () => {
    expect(seedsOf(outcome => outcome.fetchCalls !== 1)).toEqual([]);
    expect(seedsOf(outcome => outcome.method !== 'GET')).toEqual([]);
    expect(seedsOf(outcome => outcome.timersLeaked !== 0)).toEqual([]);
  });

  it('rejects every non-2xx, empty, errored, or unparseable response with the typed error', () => {
    expect(
      seedsOf(
        outcome =>
          (outcome.transport !== 'body' ||
            outcome.status < 200 ||
            outcome.status > 299) &&
          outcome.impl !== 'ProgressApiError',
      ),
    ).toEqual([]);
  });

  it('returns exactly the strict value for every payload the strict contract accepts', () => {
    expect(seedsOf(outcome => outcome.class === 'mismatch')).toEqual([]);
    expect(seedsOf(outcome => outcome.class === 'over_reject')).toEqual([]);
  });

  it('rejects wrong-typed numeric fields (null/boolean/array/object/blank) instead of coercing them', () => {
    expect(seedsOf(outcome => outcome.class === 'lenient_type')).toEqual([]);
  });

  it('covers every required malformed category at least once', () => {
    const mutations = outcomes.map(outcome => outcome.mutation).join('\n');
    for (const needle of [
      'json.truncated',
      'wrongType',
      'prototypeKey',
      'boundaryToken',
      'hostile',
      'futureSchemaFields',
      'emptyArrays',
      'http.',
      'transport.',
    ]) {
      expect(mutations).toContain(needle);
    }
    expect(outcomes.some(outcome => outcome.bodyBytes >= 65_536)).toBe(true);
  });
});
