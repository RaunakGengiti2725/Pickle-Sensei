/**
 * Seeded generators for the BOUNDARY/MALFORMED lens: malformed/truncated JSON
 * text, wrong types, prototype-pollution keys, numeric edge values, null
 * bytes, 64KB+ strings measured in bytes vs code points vs graphemes, path
 * traversal in id-like fields, future schema versions, empty containers and
 * unicode normalization pairs.
 *
 * Everything is a pure function of the `SeededRng`, so a seed fully
 * determines the generated input.
 */
import type { SeededRng } from './rng';

export const POLLUTION_KEYS = [
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'toString',
  'valueOf',
  '__defineGetter__',
  'isPrototypeOf',
] as const;

/** Sentinel own-key we inject through pollution vectors and later assert is
 * absent from `Object.prototype`. */
export const POLLUTION_SENTINEL = 'stressPolluted';

export const TRAVERSAL_STRINGS = [
  '../../etc/passwd',
  '..\\..\\windows\\system32',
  '/v1/me/../admin',
  '%2e%2e%2f%2e%2e%2fetc',
  '..%c0%af..%c0%af',
  'file:///etc/passwd',
  '\u002e\u002e\u2215etc',
  '....//....//',
] as const;

/** NFC/NFD and compatibility pairs whose members are different strings but
 * render identically (or are canonically equivalent). */
export const NORMALIZATION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['\u00e9', 'e\u0301'], // é NFC vs NFD
  ['\u00c5', 'A\u030a'], // Å
  ['\ufb01', 'fi'], // ﬁ ligature vs fi
  ['\u212a', 'K'], // Kelvin sign vs K
  ['\u2126', '\u03a9'], // Ohm vs Omega
  ['\uff52\uff49\uff47\uff48\uff54', 'right'], // fullwidth right
  ['r\u0456ght', 'right'], // Cyrillic і
  ['\u1e9b\u0323', '\u1e69'], // ṩ decomposed vs composed
  ['\u0041\u030a\u0323', '\u1ea0\u030a'],
];

const OS_LIKE = ['17.5.1', '18.0', '26.0', '0', '1e3', '17.5\u0000'] as const;

/** Grapheme cluster with a large byte/code-point/grapheme ratio: one visible
 * family emoji = 7 code points, 11 UTF-16 units, 25 UTF-8 bytes. */
const ZWJ_FAMILY = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}';

export const SIXTY_FOUR_KB = 64 * 1024;

export interface BigStringSpec {
  kind:
    | 'ascii-64k+1'
    | 'ascii-exactly-64k'
    | 'nfd-e-acute-64k-codepoints'
    | 'zwj-family-64k-bytes'
    | 'cjk-64k-bytes'
    | 'null-bytes-64k'
    | 'ascii-1mb';
  value: string;
  utf16Units: number;
  codePoints: number;
  utf8Bytes: number;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function codePoints(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

export function bigString(rng: SeededRng): BigStringSpec {
  const kind = rng.pick([
    'ascii-64k+1',
    'ascii-exactly-64k',
    'nfd-e-acute-64k-codepoints',
    'zwj-family-64k-bytes',
    'cjk-64k-bytes',
    'null-bytes-64k',
    'ascii-1mb',
  ] as const);
  let value: string;
  switch (kind) {
    case 'ascii-64k+1':
      value = 'a'.repeat(SIXTY_FOUR_KB + 1);
      break;
    case 'ascii-exactly-64k':
      value = 'b'.repeat(SIXTY_FOUR_KB);
      break;
    case 'nfd-e-acute-64k-codepoints':
      value = 'e\u0301'.repeat(SIXTY_FOUR_KB / 2 + 1);
      break;
    case 'zwj-family-64k-bytes':
      value = ZWJ_FAMILY.repeat(Math.ceil(SIXTY_FOUR_KB / 25) + 1);
      break;
    case 'cjk-64k-bytes':
      value = '\u6c34'.repeat(Math.ceil(SIXTY_FOUR_KB / 3) + 1);
      break;
    case 'null-bytes-64k':
      value = '\u0000'.repeat(SIXTY_FOUR_KB + 7);
      break;
    case 'ascii-1mb':
      value = 'z'.repeat(1024 * 1024);
      break;
  }
  return {
    kind,
    value,
    utf16Units: value.length,
    codePoints: codePoints(value),
    utf8Bytes: utf8Bytes(value),
  };
}

/** Small hostile strings: null bytes, bidi/zero-width, lone surrogates,
 * traversal, whitespace-only, confusables. */
export function hostileString(rng: SeededRng): string {
  return rng.pick([
    '',
    ' ',
    '\t\n\r ',
    '\u0000',
    'right\u0000',
    '\u0000right',
    'ri\u0000ght',
    '\u200b',
    '\u202e\u0074\u0068\u0067\u0069\u0072', // RTL override
    '\ufeffright',
    '\ud800', // lone high surrogate
    '\udfff', // lone low surrogate
    'a\ud800b',
    'RIGHT',
    'Right ',
    ' right',
    '\u{1F3D3}',
    ZWJ_FAMILY,
    'null',
    'undefined',
    'NaN',
    '[object Object]',
    '{"a":1}',
    '<script>alert(1)</script>',
    "' OR 1=1 --",
    '${jndi:ldap://x}',
    '%00',
    '\\u0000',
    rng.pick(TRAVERSAL_STRINGS),
    rng.pick(NORMALIZATION_PAIRS)[rng.int(0, 1)] as string,
    rng.pick(POLLUTION_KEYS),
  ]);
}

/** Numeric edge values (as JS numbers — `NaN`/`Infinity` cannot cross JSON
 * text, so they are used for direct-argument targets and for the `-0`,
 * overflow and precision-loss cases that DO survive JSON). */
export function edgeNumber(rng: SeededRng): number {
  return rng.pick([
    0,
    -0,
    1,
    -1,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    -Number.MAX_VALUE,
    2 ** 31,
    2 ** 32,
    2 ** 53,
    2 ** 64,
    1e308,
    -1e-308,
    0.1 + 0.2,
    4294967295,
    -2147483648,
  ]);
}

export type WrongTypeKind =
  | 'null'
  | 'undefined'
  | 'number'
  | 'boolean'
  | 'array-empty'
  | 'array-nested'
  | 'object-empty'
  | 'object-nested'
  | 'string-hostile'
  | 'string-big'
  | 'bigint'
  | 'symbol'
  | 'function'
  | 'date'
  | 'cyclic'
  | 'null-proto'
  | 'polluted-literal';

/** A value that is the WRONG JS type for wherever it is spliced in. Callers
 * targeting JSON text should pass `jsonSafe: true` to avoid values that
 * `JSON.stringify` cannot carry (they are still valid for direct-argument
 * targets, where the module under test is what calls JSON.stringify). */
export function wrongTypeValue(
  rng: SeededRng,
  options: { jsonSafe: boolean; depth?: number } = { jsonSafe: true },
): unknown {
  const depth = options.depth ?? 0;
  const kinds: WrongTypeKind[] = [
    'null',
    'number',
    'boolean',
    'array-empty',
    'array-nested',
    'object-empty',
    'object-nested',
    'string-hostile',
    'string-big',
    'polluted-literal',
  ];
  if (!options.jsonSafe) {
    kinds.push(
      'undefined',
      'bigint',
      'symbol',
      'function',
      'date',
      'cyclic',
      'null-proto',
    );
  }
  const kind = rng.pick(kinds);
  switch (kind) {
    case 'null':
      return null;
    case 'undefined':
      return undefined;
    case 'number':
      return edgeNumber(rng);
    case 'boolean':
      return rng.chance(0.5);
    case 'array-empty':
      return [];
    case 'array-nested':
      return depth > 2
        ? [[]]
        : [
            wrongTypeValue(rng, { ...options, depth: depth + 1 }),
            wrongTypeValue(rng, { ...options, depth: depth + 1 }),
          ];
    case 'object-empty':
      return {};
    case 'object-nested':
      return depth > 2
        ? { nested: {} }
        : {
            [hostileString(rng)]: wrongTypeValue(rng, {
              ...options,
              depth: depth + 1,
            }),
            schemaVersion: rng.pick([2, 99, '3.0', -1, Infinity]),
          };
    case 'string-hostile':
      return hostileString(rng);
    case 'string-big':
      return bigString(rng).value;
    case 'bigint':
      return BigInt(rng.pick(['0', '1', '18446744073709551616']));
    case 'symbol':
      return Symbol('stress');
    case 'function':
      return () => 'stress';
    case 'date':
      return new Date(rng.pick([0, NaN, 8.64e15, -8.64e15]));
    case 'cyclic': {
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;
      return cyclic;
    }
    case 'null-proto':
      return Object.create(null) as unknown;
    case 'polluted-literal': {
      // JSON.parse('{"__proto__":{...}}') yields an OWN `__proto__` key; a
      // literal `{__proto__: ...}` would instead set the prototype. Both
      // shapes are produced here so consumers see each variant.
      const pollution: Record<string, unknown> = {};
      Object.defineProperty(pollution, rng.pick(POLLUTION_KEYS), {
        value: { [POLLUTION_SENTINEL]: true },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return pollution;
    }
  }
}

/** Mutates a (mostly valid) plain object in place with `count` boundary
 * edits: wrong types, deleted keys, pollution keys, future schema markers,
 * empty containers. Returns a short label list for the results table. */
export function mutateRecord(
  rng: SeededRng,
  record: Record<string, unknown>,
  count: number,
  options: { jsonSafe: boolean },
): string[] {
  const labels: string[] = [];
  const keys = Object.keys(record);
  for (let i = 0; i < count; i += 1) {
    const op = rng.pick([
      'wrong-type',
      'wrong-type',
      'delete',
      'hostile-string',
      'big-string',
      'edge-number',
      'pollution-key',
      'pollution-value',
      'future-schema',
      'empty-array',
      'empty-object',
      'traversal',
      'normalization',
    ] as const);
    const key = keys.length > 0 ? rng.pick(keys) : 'extra';
    switch (op) {
      case 'wrong-type':
        record[key] = wrongTypeValue(rng, options);
        break;
      case 'delete':
        delete record[key];
        break;
      case 'hostile-string':
        record[key] = hostileString(rng);
        break;
      case 'big-string':
        record[key] = bigString(rng).value;
        break;
      case 'edge-number':
        record[key] = edgeNumber(rng);
        break;
      case 'pollution-key': {
        const pollutionKey = rng.pick(POLLUTION_KEYS);
        Object.defineProperty(record, pollutionKey, {
          value: { [POLLUTION_SENTINEL]: true },
          enumerable: true,
          configurable: true,
          writable: true,
        });
        break;
      }
      case 'pollution-value':
        record[key] = rng.pick(POLLUTION_KEYS);
        break;
      case 'future-schema':
        record['schemaVersion'] = rng.pick([2, 99, '3.0', -1]);
        record['version'] = rng.pick(['v2', 'v99', 2, null]);
        break;
      case 'empty-array':
        record[key] = [];
        break;
      case 'empty-object':
        record[key] = {};
        break;
      case 'traversal':
        record[key] = rng.pick(TRAVERSAL_STRINGS);
        break;
      case 'normalization': {
        const pair = rng.pick(NORMALIZATION_PAIRS);
        record[key] = pair[rng.int(0, 1)];
        break;
      }
    }
    labels.push(`${op}:${key}`);
  }
  return labels;
}

export type BodyTextKind =
  | 'json'
  | 'truncated-json'
  | 'trailing-garbage'
  | 'nan-token'
  | 'infinity-token'
  | 'negative-zero'
  | 'overflow-literal'
  | 'undefined-token'
  | 'empty'
  | 'whitespace'
  | 'null-bytes'
  | 'bom-prefixed'
  | 'html'
  | 'deep-nesting'
  | 'proto-text'
  | 'bare-string'
  | 'bare-number'
  | 'bare-array'
  | 'bare-null'
  | 'duplicate-keys'
  | 'lone-surrogate-escape'
  | 'big-string-body';

/** Serialises `value` into response text, optionally corrupting it in a
 * seed-determined way. `json` means well-formed. */
export function bodyText(
  rng: SeededRng,
  value: unknown,
): { kind: BodyTextKind; text: string } {
  const wellFormed = safeStringify(value);
  const kind: BodyTextKind = rng.chance(0.55)
    ? 'json'
    : rng.pick([
        'truncated-json',
        'trailing-garbage',
        'nan-token',
        'infinity-token',
        'negative-zero',
        'overflow-literal',
        'undefined-token',
        'empty',
        'whitespace',
        'null-bytes',
        'bom-prefixed',
        'html',
        'deep-nesting',
        'proto-text',
        'bare-string',
        'bare-number',
        'bare-array',
        'bare-null',
        'duplicate-keys',
        'lone-surrogate-escape',
        'big-string-body',
      ] as const);
  switch (kind) {
    case 'json':
      return { kind, text: wellFormed };
    case 'truncated-json':
      return {
        kind,
        text: wellFormed.slice(
          0,
          rng.int(0, Math.max(0, wellFormed.length - 1)),
        ),
      };
    case 'trailing-garbage':
      return {
        kind,
        text: `${wellFormed}${rng.pick(['}', ']', 'x', ',', '\u0000', '{}'])}`,
      };
    case 'nan-token':
      return {
        kind,
        text: wellFormed.replace(/:(?:"[^"]*"|[^,}\]]+)/, ':NaN'),
      };
    case 'infinity-token':
      return {
        kind,
        text: wellFormed.replace(/:(?:"[^"]*"|[^,}\]]+)/, ':-Infinity'),
      };
    case 'negative-zero':
      return { kind, text: wellFormed.replace(/:(?:"[^"]*"|[^,}\]]+)/, ':-0') };
    case 'overflow-literal':
      return {
        kind,
        text: wellFormed.replace(
          /:(?:"[^"]*"|[^,}\]]+)/,
          `:${rng.pick(['1e999', '-1e999', '99999999999999999999999', '1e-999'])}`,
        ),
      };
    case 'undefined-token':
      return {
        kind,
        text: wellFormed.replace(/:(?:"[^"]*"|[^,}\]]+)/, ':undefined'),
      };
    case 'empty':
      return { kind, text: '' };
    case 'whitespace':
      return { kind, text: rng.pick([' ', '\n', '\t\r\n ', '\u00a0']) };
    case 'null-bytes':
      return {
        kind,
        text: `${wellFormed.slice(0, 1)}\u0000${wellFormed.slice(1)}`,
      };
    case 'bom-prefixed':
      return { kind, text: `\ufeff${wellFormed}` };
    case 'html':
      return {
        kind,
        text: '<!doctype html><html><body>502 Bad Gateway</body></html>',
      };
    case 'deep-nesting': {
      const depth = rng.pick([64, 4096, 100_000]);
      return { kind, text: `${'['.repeat(depth)}${']'.repeat(depth)}` };
    }
    case 'proto-text':
      return {
        kind,
        text: `{"__proto__":{"${POLLUTION_SENTINEL}":true},"constructor":{"prototype":{"${POLLUTION_SENTINEL}":true}},${wellFormed.slice(1)}`,
      };
    case 'bare-string':
      return { kind, text: JSON.stringify(hostileString(rng)) };
    case 'bare-number':
      return { kind, text: rng.pick(['0', '-0', '1e999', '9007199254740993']) };
    case 'bare-array':
      return {
        kind,
        text: rng.pick(['[]', '[{}]', '[null]', `[${wellFormed}]`]),
      };
    case 'bare-null':
      return { kind, text: rng.pick(['null', 'true', 'false']) };
    case 'duplicate-keys':
      return {
        kind,
        text: `{${wellFormed.slice(1, -1)},${wellFormed.slice(1, -1)}}`,
      };
    case 'lone-surrogate-escape':
      return {
        kind,
        text: wellFormed.replace(/"([^"]*)"/, '"\\ud800$1\\udfff"'),
      };
    case 'big-string-body':
      return { kind, text: JSON.stringify(bigString(rng).value) };
  }
}

/** JSON.stringify that never throws (BigInt/cyclic/symbol/function become a
 * marker string so the campaign can still record the payload). */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const text = JSON.stringify(value, (_key, inner: unknown) => {
      if (typeof inner === 'bigint') return `<bigint:${inner.toString()}>`;
      if (typeof inner === 'symbol') return '<symbol>';
      if (typeof inner === 'function') return '<function>';
      if (inner && typeof inner === 'object') {
        if (seen.has(inner)) return '<cyclic>';
        seen.add(inner);
      }
      return inner;
    });
    return text === undefined ? 'undefined' : text;
  } catch {
    return '<unserialisable>';
  }
}

/** Compact, table-friendly rendering of a payload (bounded length). */
export function digest(value: unknown, max = 160): string {
  const text =
    typeof value === 'string' ? JSON.stringify(value) : safeStringify(value);
  return text.length > max
    ? `${text.slice(0, max)}…(+${text.length - max} chars)`
    : text;
}

export const HTTP_STATUSES = [
  200, 200, 200, 201, 204, 400, 401, 403, 404, 409, 410, 422, 429, 500, 502,
  503, 504, 100, 199, 299, 301, 304, 599,
] as const;

export function edgeOsVersion(rng: SeededRng): unknown {
  return rng.chance(0.5)
    ? rng.pick(OS_LIKE)
    : wrongTypeValue(rng, { jsonSafe: false });
}
