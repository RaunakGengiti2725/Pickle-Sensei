import { Rng } from './rng';
import { bytesToHex, utf8Encode } from './node';

/**
 * A single SQLite cell value the harness seeds into a pre-migration database.
 * Cells render to SQL literals (never bound parameters) so embedded NUL bytes,
 * blobs, out-of-range integers and IEEE specials reach the file exactly as an
 * older build, a corrupting process or a hostile writer could have left them.
 */
export type Cell =
  | { kind: 'null' }
  | { kind: 'int'; literal: string }
  | { kind: 'real'; literal: string }
  | { kind: 'text'; value: string }
  | { kind: 'blob'; bytes: Uint8Array }
  | { kind: 'expr'; sql: string; describe: string };

export const NULL: Cell = { kind: 'null' };
export const text = (value: string): Cell => ({ kind: 'text', value });
export const int = (literal: string | number): Cell => ({
  kind: 'int',
  literal: String(literal),
});
export const real = (literal: string): Cell => ({ kind: 'real', literal });
export const blob = (bytes: Uint8Array): Cell => ({ kind: 'blob', bytes });
export const textBlob = (value: string): Cell => blob(utf8Encode(value));
export const expr = (sql: string, describe = sql): Cell => ({
  kind: 'expr',
  sql,
  describe,
});

function quoteText(value: string): string {
  if (value.length === 0) return "''";
  const segments = value.split('\u0000');
  const quoted = segments.map(s => `'${s.replace(/'/g, "''")}'`);
  return quoted.join('||char(0)||');
}

export function sqlLiteral(cell: Cell): string {
  switch (cell.kind) {
    case 'null':
      return 'NULL';
    case 'int':
    case 'real':
      return cell.literal;
    case 'text':
      return quoteText(cell.value);
    case 'blob':
      return cell.bytes.length === 0 ? "X''" : `X'${bytesToHex(cell.bytes)}'`;
    case 'expr':
      return cell.sql;
  }
}

/** Compact, JSON-safe description of a cell for the artifact table. */
export function describeCell(cell: Cell): string {
  switch (cell.kind) {
    case 'null':
      return 'NULL';
    case 'int':
      return `int:${cell.literal}`;
    case 'real':
      return `real:${cell.literal}`;
    case 'text': {
      const v = cell.value;
      const shown = v.length > 80 ? `${v.slice(0, 40)}…${v.slice(-20)}` : v;
      return `text[${v.length}]:${JSON.stringify(shown)}`;
    }
    case 'blob':
      return `blob[${cell.bytes.length}]`;
    case 'expr':
      return `expr:${cell.describe}`;
  }
}

// ─── Corpus building blocks ─────────────────────────────────────────────────

const NFC_E = 'r\u00e9al'; // "réal" precomposed
const NFD_E = 're\u0301al'; // "réal" decomposed
const ZWJ_FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
const RTL_OVERRIDE = '\u202Ereal\u202C';
const FULLWIDTH_REAL = '\uFF52\uFF45\uFF41\uFF4C';

export const PATH_TRAVERSAL_IDS: readonly string[] = [
  '../../etc/passwd',
  '..\\..\\Windows\\system32',
  '%2e%2e%2f%2e%2e%2fetc',
  '/dev/null',
  'file:///var/mobile/Containers',
  '....//....//',
  'pickle-sensei.db',
  '..;/',
  '\u2025/\u2025/',
];

export const INJECTION_TEXTS: readonly string[] = [
  "'; DROP TABLE local_shot; --",
  '" OR 1=1 --',
  "real' OR '1'='1",
  'real; DELETE FROM outbox;',
  '${jndi:ldap://x}',
  '{{7*7}}',
];

export const PROTO_KEYS: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'hasOwnProperty',
  '__defineGetter__',
];

export function hugeString(rng: Rng): string {
  const unit = rng.weighted<string>([
    ['a', 4],
    ['\u00e9', 2],
    ['\u{1F3D3}', 2],
    [ZWJ_FAMILY, 1],
    ['\u0301', 1],
    ['\u0000', 1],
  ]);
  const target = rng.weighted<number>([
    [65535, 2],
    [65536, 3],
    [65537, 3],
    [100000, 1],
    [262144, 1],
    [1048576, 1],
  ]);
  const reps = Math.ceil(target / unit.length);
  return unit.repeat(reps);
}

export function unicodeVariant(rng: Rng): string {
  return rng.pick([
    NFC_E,
    NFD_E,
    ZWJ_FAMILY,
    RTL_OVERRIDE,
    FULLWIDTH_REAL,
    '\uFEFFreal',
    'real\u200B',
    '\u0000',
    'a\u0000b',
    'İ'.toLowerCase(),
    'ß'.toUpperCase(),
    '\uD83D', // lone high surrogate; encodes as U+FFFD
    'e\u0301\u0301\u0301\u0301\u0301',
  ]);
}

export function numericLiteral(rng: Rng): Cell {
  return rng.weighted<Cell>([
    [int(0), 3],
    [int(1), 3],
    [int(-1), 1],
    [real('0.0'), 1],
    [real('-0.0'), 2],
    [real('1e400'), 2],
    [real('-1e400'), 1],
    [real('1e308'), 1],
    [real('4.9e-324'), 1],
    [real('0.1'), 1],
    [int('9007199254740993'), 1],
    [int('9223372036854775807'), 1],
    [int('-9223372036854775808'), 1],
    [real('9223372036854775808'), 1],
    [real('1.7976931348623157e308'), 1],
    [int('00012'), 1],
    [text('abc'), 1],
    [text('1.5'), 1],
    [text(' 1'), 1],
    [text('0x10'), 1],
    [text('1e400'), 1],
    [text('NaN'), 1],
    [text('Infinity'), 1],
    [text(''), 1],
    [textBlob('1'), 1],
  ]);
}

/** Cell for an INTEGER-affinity flag column (favorite / completed). */
export function flagLiteral(rng: Rng): Cell {
  return rng.weighted<Cell>([
    [int(0), 6],
    [int(1), 6],
    [int(2), 1],
    [int(-1), 1],
    [text('0'), 1],
    [text('1'), 1],
    [text('yes'), 1],
    [text('0.0'), 1],
    [real('-0.0'), 1],
    [real('1e400'), 1],
    [int('9223372036854775807'), 1],
    [textBlob('0'), 1],
    [text(''), 1],
  ]);
}

// ─── JSON payload corpus ───────────────────────────────────────────────────

function randomSource(rng: Rng): string {
  return rng.weighted<string>([
    ['"real"', 8],
    ['"fixture"', 5],
    ['"synthetic"', 1],
    ['"demo"', 1],
    ['"REAL"', 1],
    ['"Real"', 1],
    ['"real "', 1],
    ['" real"', 1],
    ['"real\\u0000"', 1],
    ['"\\u0072eal"', 1],
    ['"re\\u0061l"', 1],
    [JSON.stringify(NFC_E), 1],
    [JSON.stringify(NFD_E), 1],
    [JSON.stringify(RTL_OVERRIDE), 1],
    [JSON.stringify(FULLWIDTH_REAL), 1],
    ['1', 1],
    ['1.5', 1],
    ['true', 1],
    ['false', 1],
    ['null', 2],
    ['[]', 1],
    ['{}', 1],
    ['["real"]', 1],
    ['{"source":"real"}', 1],
    ['-0', 1],
    ['1e400', 1],
    ['9007199254740993', 1],
    ['-9223372036854775809', 1],
    ['""', 1],
  ]);
}

function randomExtraMember(rng: Rng, nonce: string): string {
  const entries: readonly (readonly [() => string, number])[] = [
    [() => `"id":"${nonce}"`, 6],
    [
      () =>
        `"overallScore":${rng.pick(['0', '-0', '1e400', '0.1', '100', '-1'])}`,
      2,
    ],
    [() => `"schemaVersion":${rng.pick(['99', '2', '"3.0.0"', 'null'])}`, 2],
    [() => `"$schema":"https://example.invalid/future"`, 1],
    [() => `"note":${JSON.stringify(hugeString(rng))}`, 1],
    [() => `"path":${JSON.stringify(rng.pick(PATH_TRAVERSAL_IDS))}`, 1],
    [() => `"sql":${JSON.stringify(rng.pick(INJECTION_TEXTS))}`, 1],
    [() => `"empty":{}`, 1],
    [() => `"list":[]`, 1],
    [() => `"nested":{"a":{"b":{"c":[]}}}`, 1],
    [() => `"u":${JSON.stringify(unicodeVariant(rng))}`, 1],
    [() => `${JSON.stringify(rng.pick(PROTO_KEYS))}:{"source":"fixture"}`, 2],
    [() => `${JSON.stringify(rng.pick(PROTO_KEYS))}:null`, 1],
    [() => `"big":123456789012345678901234567890`, 1],
    [() => `"tiny":1e-400`, 1],
    [() => `"esc":"\\ud83d\\ude00\\n\\t\\/"`, 1],
    [() => `"lone":"\\ud800"`, 1],
    [() => `"\\u0073ource":"fixture"`, 1],
  ];
  return rng.weighted(entries)();
}

function wellFormedObject(rng: Rng, nonce: string): string {
  const members: string[] = [];
  const sourceFirst = rng.chance(0.7);
  const source = `"source":${randomSource(rng)}`;
  if (sourceFirst) members.push(source);
  const extra = rng.int(0, 3);
  for (let i = 0; i < extra; i++) members.push(randomExtraMember(rng, nonce));
  if (!sourceFirst && rng.chance(0.85)) members.push(source);
  if (rng.chance(0.08)) members.push(`"source":${randomSource(rng)}`);
  const sep = rng.chance(0.1) ? ' , ' : ',';
  return `{${members.join(sep)}}`;
}

function deepNesting(rng: Rng): string {
  const depth = rng.weighted<number>([
    [10, 2],
    [999, 2],
    [1000, 2],
    [1001, 2],
    [5000, 1],
    [50000, 1],
  ]);
  const open = rng.chance(0.5) ? '[' : '{"a":';
  const close = open === '[' ? ']' : '}';
  const core = open === '[' ? '' : '0';
  const inner = open.repeat(depth) + core + close.repeat(depth);
  return rng.chance(0.5)
    ? `{"source":"fixture","d":${inner}}`
    : `{"d":${inner},"source":"fixture"}`;
}

function json5ish(rng: Rng): string {
  return rng.pick([
    `{source:"fixture"}`,
    `{'source':'fixture'}`,
    `{"source":"fixture",}`,
    `{"source":NaN}`,
    `{"source":Infinity}`,
    `{"source":-Infinity}`,
    `{"source":0x10}`,
    `{"source":+1}`,
    `{"source":.5}`,
    `{"source":1.}`,
    `{"source":01}`,
    `{"source":"fixture"}//c`,
    `/*c*/{"source":"fixture"}`,
    `{"source":"fix\nture"}`,
    `{"source":"\\x41"}`,
    `{"source":undefined}`,
    `{"source":"fixture"}{"source":"real"}`,
  ]);
}

/**
 * Generates an outbox / shot payload cell. Roughly a third are valid objects
 * (real or fixture, sometimes with duplicate or prototype keys), the rest are
 * truncated, decorated, JSON5-ish, deeply nested, scalar, empty, huge, NUL
 * bearing, or binary.
 */
export function payloadCell(rng: Rng, nonce: string): Cell {
  const kind = rng.weighted<string>([
    ['object', 34],
    ['truncated', 12],
    ['trailing', 6],
    ['leading', 5],
    ['json5', 6],
    ['deep', 5],
    ['scalar', 6],
    ['empty', 4],
    ['huge', 5],
    ['nul', 4],
    ['blob', 5],
    ['expr', 3],
    ['numeric', 3],
    ['injection', 2],
  ]);
  switch (kind) {
    case 'object':
      return text(wellFormedObject(rng, nonce));
    case 'truncated': {
      const full = wellFormedObject(rng, nonce);
      return text(full.slice(0, rng.int(0, Math.max(0, full.length - 1))));
    }
    case 'trailing':
      return text(
        wellFormedObject(rng, nonce) +
          rng.pick([' x', '}', ',', '\u0000', ' ', '\n', '\uFEFF', ']', '0']),
      );
    case 'leading':
      return text(
        rng.pick(['\uFEFF', ' ', '\n\t', '\u0000', '//c\n', 'x', '\u00A0']) +
          wellFormedObject(rng, nonce),
      );
    case 'json5':
      return text(json5ish(rng));
    case 'deep':
      return text(deepNesting(rng));
    case 'scalar':
      return text(
        rng.pick([
          '"real"',
          '"fixture"',
          '42',
          'null',
          'true',
          '[]',
          '[1,2]',
          '["real"]',
          '[{"source":"fixture"}]',
          '-0',
          '1e400',
        ]),
      );
    case 'empty':
      return text(rng.pick(['', ' ', '\n', '{}', '[]', '\u0000']));
    case 'huge': {
      const huge = hugeString(rng);
      return text(
        rng.pick([
          `{"source":"real","note":${JSON.stringify(huge)}}`,
          `{"source":"fixture","note":${JSON.stringify(huge)}}`,
          `{"source":${JSON.stringify(huge)}}`,
          huge,
          `{"source":"real","note":"${huge}`,
        ]),
      );
    }
    case 'nul':
      return text(
        rng.pick([
          `{"source":"fix\u0000ture"}`,
          `{"source":"fixture"}\u0000`,
          `{"source":"fixture"}\u0000{"source":"real"}`,
          `{"source":"real"}\u0000`,
          `\u0000{"source":"fixture"}`,
          `{"source":"real\u0000"}`,
          `{"sou\u0000rce":"fixture"}`,
        ]),
      );
    case 'blob':
      return rng.chance(0.6)
        ? textBlob(wellFormedObject(rng, nonce))
        : blob(new Uint8Array([0x00, 0xff, 0xfe, 0x7b, 0x22, 0x80, 0x00]));
    case 'expr':
      return rng.pick([
        expr(`jsonb('{"source":"fixture"}')`, 'jsonb(fixture)'),
        expr(`jsonb('{"source":"real"}')`, 'jsonb(real)'),
        expr(`zeroblob(70000)`, 'zeroblob(70000)'),
        expr(`CAST('{"source":"fixture"}' AS BLOB)`, 'blob(fixture)'),
        expr(`json('{"source":"fixture"}')`, 'json(fixture)'),
      ]);
    case 'numeric':
      return rng.pick([int(42), real('-0.0'), real('1e400'), int('0')]);
    default:
      return text(rng.pick(INJECTION_TEXTS));
  }
}

// ─── Identifier / text corpus ──────────────────────────────────────────────

/** Unique-by-construction id: a malformed shape plus a per-row nonce. */
export function idCell(rng: Rng, nonce: string): Cell {
  const shape = rng.weighted<string>([
    ['uuid', 8],
    ['traversal', 3],
    ['empty', 1],
    ['huge', 2],
    ['nul', 2],
    ['unicode', 3],
    ['injection', 2],
    ['proto', 2],
    ['numeric', 2],
    ['blob', 1],
    ['ws', 1],
  ]);
  switch (shape) {
    case 'uuid':
      return text(`${rng.uuid()}~${nonce}`);
    case 'traversal':
      return text(`${rng.pick(PATH_TRAVERSAL_IDS)}~${nonce}`);
    case 'empty':
      return text(`~${nonce}`);
    case 'huge':
      return text(`${hugeString(rng)}~${nonce}`);
    case 'nul':
      return text(rng.pick([`\u0000~${nonce}`, `a\u0000b~${nonce}`]));
    case 'unicode':
      return text(`${unicodeVariant(rng)}~${nonce}`);
    case 'injection':
      return text(`${rng.pick(INJECTION_TEXTS)}~${nonce}`);
    case 'proto':
      return text(`${rng.pick(PROTO_KEYS)}~${nonce}`);
    case 'numeric':
      return text(
        `${rng.pick(['0', '-1', '1e400', '00', '9007199254740993'])}~${nonce}`,
      );
    case 'blob':
      return textBlob(`blob~${nonce}`);
    default:
      return text(`  ~${nonce}  `);
  }
}

type Lazy = readonly [() => Cell, number];

function lazyPick(rng: Rng, entries: readonly Lazy[]): Cell {
  return rng.weighted(entries)();
}

export function ownerCell(rng: Rng): Cell {
  return lazyPick(rng, [
    [() => text('device-guest'), 4],
    [() => text('apple:7fc2c743-028f-4ec6-942c-a84508f3be38'), 4],
    [() => text('google:0b4d1f9e-3c2a-4b8e-9f1d-2a6c7e8b9d01'), 2],
    [() => text(''), 1],
    [() => text('../../etc'), 1],
    [() => text('device-guest\u0000'), 1],
    [() => text(NFD_E), 1],
    [() => text('__proto__'), 1],
    [() => text(hugeString(rng)), 1],
  ]);
}

/** `source` column of local_shot — the purge keys on exact text 'real'. */
export function sourceCell(rng: Rng): Cell {
  return lazyPick(rng, [
    [() => text('real'), 12],
    [() => text('fixture'), 5],
    [() => text('synthetic'), 1],
    [() => text('REAL'), 1],
    [() => text('Real'), 1],
    [() => text('real '), 1],
    [() => text(' real'), 1],
    [() => text('real\u0000'), 1],
    [() => text('\u0000real'), 1],
    [() => text(''), 1],
    [() => text(NFC_E), 1],
    [() => text(NFD_E), 1],
    [() => text(FULLWIDTH_REAL), 1],
    [() => text(RTL_OVERRIDE), 1],
    [() => textBlob('real'), 1],
    [() => int(1), 1],
    [() => text(hugeString(rng)), 1],
    [() => expr(`CAST('real' AS BLOB)`, 'blob(real)'), 1],
  ]);
}

export function summaryCell(rng: Rng): Cell {
  return lazyPick(rng, [
    [() => NULL, 5],
    [() => text('{"engineVersion":"1.0","topCorrection":null}'), 4],
    [() => text('{"note":"fixture"}'), 2],
    [() => text('{"note":"FIXTURE"}'), 1],
    [() => text('{"note":"Fixtures"}'), 1],
    [() => text('fixture'), 1],
    [() => text('fix\u0000ture'), 1],
    [() => text('fixture\u0000x'), 1],
    [() => text('f\u0131xture'), 1],
    [() => text('f%xture'), 1],
    [() => text('f_xture'), 1],
    [() => text(''), 1],
    [() => text('not json'), 1],
    [() => text(hugeString(rng)), 1],
    [() => textBlob('fixture'), 1],
    [() => textBlob('{"a":1}'), 1],
  ]);
}

export function shortText(rng: Rng): Cell {
  return lazyPick(rng, [
    [() => text('dink'), 4],
    [() => text('drive'), 2],
    [() => text(''), 1],
    [() => text(unicodeVariant(rng)), 1],
    [() => text(rng.pick(INJECTION_TEXTS)), 1],
    [() => text(rng.pick(PATH_TRAVERSAL_IDS)), 1],
    [() => text(rng.pick(PROTO_KEYS)), 1],
    [() => text(hugeString(rng)), 1],
    [() => textBlob('dink'), 1],
    [() => int(7), 1],
  ]);
}

export function nullableShortText(rng: Rng): Cell {
  return rng.chance(0.35) ? NULL : shortText(rng);
}

export function isoCell(rng: Rng): Cell {
  return rng.weighted<Cell>([
    [
      text(
        `2026-0${rng.int(1, 9)}-0${rng.int(1, 9)}T0${rng.int(0, 9)}:00:00.000Z`,
      ),
      8,
    ],
    [text('not-a-date'), 1],
    [text(''), 1],
    [text('9999-12-31T23:59:59.999Z'), 1],
    [text('0000-00-00T00:00:00Z'), 1],
    [text('2026-09-05T02:57:00\u0000Z'), 1],
    [int('1757037420000'), 1],
    [real('-0.0'), 1],
  ]);
}
