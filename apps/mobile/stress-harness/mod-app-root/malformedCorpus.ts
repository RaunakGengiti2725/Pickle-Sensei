import { chance, int, pick, type Rng } from './prng';

/**
 * Generated malformed inputs for the `boundary-malformed` lens against the
 * app root (App.tsx RootErrorBoundary + Gate, index.js global handlers).
 *
 * Two generators, both pure functions of an `Rng`:
 *
 * - `malformedString(rng)` — malformed/truncated JSON, prototype-pollution
 *   keys, path traversal, null bytes, 64KB+ strings (byte / codepoint /
 *   grapheme extremes), unicode normalization pairs, future schema versions,
 *   numeric edge cases as text, empty/whitespace.
 * - `hostileThrowable(rng)` — every shape a `throw`, a global error or a
 *   promise rejection can carry: real Errors with corrupted `name` /
 *   `message` / `stack` (wrong types, throwing getters, 64KB+ bodies,
 *   symbols, null-prototype objects), Error subclasses, primitives
 *   (NaN / ±Infinity / -0 / 2^53 / BigInt / Symbol / null / undefined),
 *   plain and null-prototype objects, revoked and trapping Proxies, deep
 *   `cause` chains, frozen errors, circular graphs, prototype-pollution
 *   payloads, empty arrays/objects.
 *
 * Every generated value is tagged with a `family` (coarse class) and a
 * `label` (fine class) so the JSON result tables can be grouped by input
 * kind, and `describe` is a short, always-safe rendering for the table (the
 * value itself may be hostile to `String()` / `JSON.stringify`).
 */

// ─── Malformed strings ────────────────────────────────────────────────────────

export type StringFamily =
  | 'json-malformed'
  | 'json-truncated'
  | 'proto-pollution'
  | 'path-traversal'
  | 'null-bytes'
  | 'huge-bytes'
  | 'huge-codepoints'
  | 'huge-graphemes'
  | 'unicode-normalization'
  | 'unicode-control'
  | 'future-schema'
  | 'numeric-text'
  | 'empty-or-space'
  | 'uuid-lookalike';

export interface GeneratedString {
  family: StringFamily;
  label: string;
  value: string;
}

const VALID_UUID = '7fc2c743-028f-4ec6-942c-a84508f3be38';

const JSON_TRUNCATIONS = [
  '{"version":1,"provider":"app',
  '{"version":',
  '[1,2,',
  '{"a":{"b":{"c":',
  '"unterminated',
  '{"k":"v"',
  '{',
  '[',
  '{"__proto__":{"polluted":tr',
];

const JSON_MALFORMED = [
  'definitely not json',
  '{a:1}',
  "{'single':'quotes'}",
  '{"trailing":1,}',
  '[1,2,3,]',
  'NaN',
  'Infinity',
  '-Infinity',
  'undefined',
  '{"a":1}{"b":2}',
  '\uFEFF{"bom":true}',
  '{"dup":1,"dup":2}',
  '{"nul":"\u0000"}',
  '{"big":1e999}',
  '{"neg0":-0}',
  '{"unicode":"\\ud800"}',
  '{"ctrl":"\u0001\u0002"}',
  'null',
  'true',
  '0',
  '""',
];

const PROTO_KEYS = [
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__lookupGetter__',
  'hasOwnProperty',
  'toString',
  'valueOf',
  'then',
  'toJSON',
];

const TRAVERSALS = [
  '../../etc/passwd',
  '..\\..\\windows\\system32',
  '%2e%2e%2f%2e%2e%2f',
  '....//....//',
  '/absolute/path',
  'C:\\Users\\x',
  'file:///etc/hosts',
  '..%c0%af..%c0%af',
  '~/.ssh/id_rsa',
  'a/../../b',
  '\u2025\u2025/',
  '.%00./',
];

const NORMALIZATION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['\u00e9', 'e\u0301'], // é NFC vs NFD
  ['\u00c5', 'A\u030a'], // Å
  ['\ufb01', 'fi'], // ﬁ ligature (NFKC)
  ['\u2126', '\u03a9'], // OHM SIGN vs OMEGA
  ['\u212b', '\u00c5'], // ANGSTROM SIGN
  ['\u1e9b\u0323', '\u1e69'], // ṩ decompositions
  ['\u0130', 'i\u0307'], // İ
  ['\uff21', 'A'], // fullwidth A (NFKC)
  ['\u2460', '1'], // ① (NFKC)
  ['\u00bd', '1\u20442'], // ½
];

const CONTROL_STRINGS = [
  '\u202e\u0644\u0627\u0644', // RTL override
  '\u200b\u200c\u200d', // zero-width
  '\u2066isolate\u2069',
  '\ufeff',
  '\u0085\u2028\u2029',
  '\ud800', // lone high surrogate
  '\udfff', // lone low surrogate
  '\ud83d', // half of an emoji
  '\u0000\u0000',
  'tab\there\nnewline\rcr',
  '\u001b[31mansi\u001b[0m',
  '\u00a0\u3000',
];

const FUTURE_SCHEMAS = [
  '{"version":2,"provider":"apple"}',
  '{"version":999999,"unknownField":{"nested":true}}',
  '{"schemaVersion":"3.0.0-beta","payload":{}}',
  '{"version":-1}',
  '{"version":"1"}',
  '{"version":1.5}',
  '{"version":null}',
  '{"version":9007199254740993}',
  '{"v":2,"events":[],"settings":{}}',
  '{"version":1,"provider":"unknown-provider-2030"}',
];

const NUMERIC_TEXT = [
  'NaN',
  '-0',
  '0',
  'Infinity',
  '-Infinity',
  '9007199254740993',
  '18446744073709551616',
  '1e309',
  '-1e309',
  '4.9e-324',
  '0x1f',
  '0b101',
  '1_000',
  '٣', // Arabic-Indic digit
  '１２３', // fullwidth
  '1,5',
  '+1',
  '00001',
  '1.',
  '.5',
];

const EMPTIES = ['', ' ', '\n', '\t', '   \n\t ', '\u3000', '\u00a0', '\r\n'];

const UUID_LOOKALIKES = [
  VALID_UUID.toUpperCase(),
  ` ${VALID_UUID} `,
  `\n${VALID_UUID}\t`,
  VALID_UUID.replace(/-/g, ''),
  `{${VALID_UUID}}`,
  `urn:uuid:${VALID_UUID}`,
  VALID_UUID.slice(0, 35),
  `${VALID_UUID}0`,
  VALID_UUID.replace('4ec6', 'zec6'),
  VALID_UUID.replace('7fc2', '7fc\u0000'),
  VALID_UUID.replace('7', '\uff17'),
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  `${VALID_UUID}/../other`,
  `${VALID_UUID}\u202e`,
  'undefined',
  'null',
  '[object Object]',
];

function repeatTo(unit: string, targetLength: number): string {
  const times = Math.ceil(targetLength / unit.length);
  return unit.repeat(times);
}

/** 64KB is the byte cap most stores/loggers apply; probe at and beyond it. */
function hugeLength(rng: Rng): number {
  return pick(rng, [65535, 65536, 65537, 131072, 262144, 1048576]);
}

export function malformedString(rng: Rng): GeneratedString {
  const family = pick<StringFamily>(rng, [
    'json-malformed',
    'json-truncated',
    'proto-pollution',
    'path-traversal',
    'null-bytes',
    'huge-bytes',
    'huge-codepoints',
    'huge-graphemes',
    'unicode-normalization',
    'unicode-control',
    'future-schema',
    'numeric-text',
    'empty-or-space',
    'uuid-lookalike',
  ]);
  switch (family) {
    case 'json-malformed': {
      const value = pick(rng, JSON_MALFORMED);
      return { family, label: `malformed:${value.slice(0, 12)}`, value };
    }
    case 'json-truncated': {
      const full = pick(rng, JSON_TRUNCATIONS);
      const cut = int(rng, 1, full.length);
      return { family, label: `truncated@${cut}`, value: full.slice(0, cut) };
    }
    case 'proto-pollution': {
      const key = pick(rng, PROTO_KEYS);
      const shape = pick(rng, ['json', 'dotted', 'bracket', 'nested']);
      const value =
        shape === 'json'
          ? `{"${key}":{"polluted":true}}`
          : shape === 'dotted'
            ? `${key}.polluted`
            : shape === 'bracket'
              ? `[${key}][polluted]`
              : `{"a":{"${key}":{"${key}":{"polluted":1}}}}`;
      return { family, label: `${key}:${shape}`, value };
    }
    case 'path-traversal': {
      const value = pick(rng, TRAVERSALS);
      return { family, label: value.slice(0, 16), value };
    }
    case 'null-bytes': {
      const position = pick(rng, ['lead', 'mid', 'trail', 'all']);
      const value =
        position === 'lead'
          ? `\u0000${VALID_UUID}`
          : position === 'mid'
            ? `${VALID_UUID.slice(0, 8)}\u0000${VALID_UUID.slice(8)}`
            : position === 'trail'
              ? `${VALID_UUID}\u0000`
              : '\u0000'.repeat(int(rng, 1, 64));
      return { family, label: `nul:${position}`, value };
    }
    case 'huge-bytes': {
      const length = hugeLength(rng);
      const unit = pick(rng, ['a', 'ab', '{"k":"v"},', '../']);
      return {
        family,
        label: `ascii:${length}`,
        value: repeatTo(unit, length).slice(0, length),
      };
    }
    case 'huge-codepoints': {
      // 4-byte UTF-8 code points: length in UTF-16 units is 2x code points.
      const length = hugeLength(rng);
      const unit = pick(rng, ['\u{1F600}', '\u{10FFFF}', '\u{1F1FA}\u{1F1F8}']);
      return {
        family,
        label: `astral:${length}`,
        value: repeatTo(unit, length).slice(0, length),
      };
    }
    case 'huge-graphemes': {
      // One grapheme, many code points (ZWJ sequences / combining marks).
      const length = hugeLength(rng);
      const unit = pick(rng, [
        '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}',
        'e\u0301\u0302\u0303\u0304\u0305\u0306\u0307',
        '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
      ]);
      return {
        family,
        label: `grapheme:${length}`,
        value: repeatTo(unit, length).slice(0, length),
      };
    }
    case 'unicode-normalization': {
      const pair = pick(rng, NORMALIZATION_PAIRS);
      const side = chance(rng, 0.5) ? 0 : 1;
      const form = pick(rng, ['raw', 'NFC', 'NFD', 'NFKC', 'NFKD'] as const);
      const raw = pair[side];
      const value = form === 'raw' ? raw : raw.normalize(form);
      return {
        family,
        label: `pair${NORMALIZATION_PAIRS.indexOf(pair)}:${side}:${form}`,
        value,
      };
    }
    case 'unicode-control': {
      const value = pick(rng, CONTROL_STRINGS);
      return { family, label: `ctrl${CONTROL_STRINGS.indexOf(value)}`, value };
    }
    case 'future-schema': {
      const value = pick(rng, FUTURE_SCHEMAS);
      return { family, label: value.slice(0, 20), value };
    }
    case 'numeric-text': {
      const value = pick(rng, NUMERIC_TEXT);
      return { family, label: value, value };
    }
    case 'empty-or-space': {
      const value = pick(rng, EMPTIES);
      return { family, label: JSON.stringify(value), value };
    }
    case 'uuid-lookalike': {
      const value = pick(rng, UUID_LOOKALIKES);
      return {
        family,
        label: `uuid${UUID_LOOKALIKES.indexOf(value)}`,
        value,
      };
    }
  }
}

// ─── Hostile throwables ───────────────────────────────────────────────────────

export type ThrowableFamily =
  | 'error-plain'
  | 'error-huge'
  | 'error-corrupt-field'
  | 'error-throwing-getter'
  | 'error-subclass'
  | 'error-frozen'
  | 'error-cause-chain'
  | 'error-like'
  | 'primitive'
  | 'number-edge'
  | 'string-malformed'
  | 'object-plain'
  | 'object-null-proto'
  | 'object-hostile-coercion'
  | 'proxy'
  | 'proto-pollution'
  | 'empty-collection'
  | 'exotic';

export interface GeneratedThrowable {
  family: ThrowableFamily;
  label: string;
  value: unknown;
  /** Safe rendering for result tables; never touches the hostile value. */
  describe: string;
}

const NON_STRING_FIELD_VALUES: ReadonlyArray<readonly [string, () => unknown]> =
  [
    ['number', () => 42],
    ['nan', () => NaN],
    ['negzero', () => -0],
    ['infinity', () => Infinity],
    ['null', () => null],
    ['undefined', () => undefined],
    ['true', () => true],
    ['object', () => ({ nested: true })],
    ['null-proto-object', () => Object.create(null) as unknown],
    ['array', () => ['a', 'b']],
    ['empty-array', () => []],
    ['symbol', () => Symbol('hostile')],
    ['bigint', () => BigInt('18446744073709551616')],
    ['function', () => () => 'fn'],
    ['huge-string', () => 'x'.repeat(70000)],
    ['nul-string', () => 'a\u0000b'],
    ['multiline', () => 'l1\n    at fake (frame:1:1)\nl3'],
  ];

const ERROR_FIELDS = ['name', 'message', 'stack'] as const;

function throwingGetter(target: object, field: string, thrown: unknown): void {
  Object.defineProperty(target, field, {
    configurable: true,
    enumerable: false,
    get() {
      throw thrown;
    },
  });
}

class HostileSubclass extends Error {
  code = 'E_HOSTILE';
  constructor(message: string) {
    super(message);
    this.name = 'HostileSubclass';
  }
}

class NoNameSubclass extends Error {
  constructor(message: string) {
    super(message);
    Object.defineProperty(this, 'name', { value: '', configurable: true });
  }
}

function frameStack(frames: number, frameLength: number): string {
  const lines = ['Error: stressed'];
  for (let i = 0; i < frames; i += 1) {
    lines.push(`    at ${'f'.repeat(frameLength)}${i} (bundle.js:${i}:${i})`);
  }
  return lines.join('\n');
}

export function hostileThrowable(rng: Rng): GeneratedThrowable {
  const family = pick<ThrowableFamily>(rng, [
    'error-plain',
    'error-huge',
    'error-corrupt-field',
    'error-throwing-getter',
    'error-subclass',
    'error-frozen',
    'error-cause-chain',
    'error-like',
    'primitive',
    'number-edge',
    'string-malformed',
    'object-plain',
    'object-null-proto',
    'object-hostile-coercion',
    'proxy',
    'proto-pollution',
    'empty-collection',
    'exotic',
  ]);
  switch (family) {
    case 'error-plain': {
      const text = malformedString(rng);
      const error = new Error(text.value);
      return {
        family,
        label: `message:${text.family}`,
        value: error,
        describe: `Error(message=${text.family}/${text.label})`,
      };
    }
    case 'error-huge': {
      const which = pick(rng, ['message', 'stack', 'both', 'stack-frames']);
      const length = hugeLength(rng);
      const error = new Error(
        which === 'message' || which === 'both' ? 'm'.repeat(length) : 'huge',
      );
      if (which === 'stack' || which === 'both') {
        error.stack = `Error: huge\n    at ${'s'.repeat(length)} (b.js:1:1)`;
      } else if (which === 'stack-frames') {
        error.stack = frameStack(int(rng, 1000, 20000), 32);
      }
      return {
        family,
        label: `${which}:${length}`,
        value: error,
        describe: `Error(huge ${which}, ${length})`,
      };
    }
    case 'error-corrupt-field': {
      const field = pick(rng, ERROR_FIELDS);
      const [valueLabel, make] = pick(rng, NON_STRING_FIELD_VALUES);
      const error = new Error('corrupt');
      Object.defineProperty(error, field, {
        value: make(),
        configurable: true,
        writable: true,
        enumerable: false,
      });
      return {
        family,
        label: `${field}=${valueLabel}`,
        value: error,
        describe: `Error(${field}=${valueLabel})`,
      };
    }
    case 'error-throwing-getter': {
      const field = pick(rng, ERROR_FIELDS);
      const thrownKind = pick(rng, ['error', 'string', 'null', 'symbol']);
      const thrown =
        thrownKind === 'error'
          ? new Error('getter refused')
          : thrownKind === 'string'
            ? 'getter refused'
            : thrownKind === 'null'
              ? null
              : Symbol('getter refused');
      const error = new Error('getter host');
      throwingGetter(error, field, thrown);
      return {
        family,
        label: `${field}:throws-${thrownKind}`,
        value: error,
        describe: `Error(${field} getter throws ${thrownKind})`,
      };
    }
    case 'error-subclass': {
      const kind = pick(rng, [
        'TypeError',
        'RangeError',
        'SyntaxError',
        'AggregateError',
        'HostileSubclass',
        'NoNameSubclass',
        'DOMException-like',
      ]);
      const text = malformedString(rng).value.slice(0, 200);
      let error: Error;
      switch (kind) {
        case 'TypeError':
          error = new TypeError(text);
          break;
        case 'RangeError':
          error = new RangeError(text);
          break;
        case 'SyntaxError':
          error = new SyntaxError(text);
          break;
        case 'AggregateError':
          error = new AggregateError([new Error('a'), 'b', null], text);
          break;
        case 'HostileSubclass':
          error = new HostileSubclass(text);
          break;
        case 'NoNameSubclass':
          error = new NoNameSubclass(text);
          break;
        default: {
          error = Object.setPrototypeOf(
            { name: 'AbortError', message: text, code: 20 },
            Error.prototype,
          ) as Error;
        }
      }
      return { family, label: kind, value: error, describe: `${kind}()` };
    }
    case 'error-frozen': {
      const mode = pick(rng, ['freeze', 'seal', 'preventExtensions']);
      const error = new Error('immutable');
      if (mode === 'freeze') Object.freeze(error);
      else if (mode === 'seal') Object.seal(error);
      else Object.preventExtensions(error);
      return { family, label: mode, value: error, describe: `Error(${mode})` };
    }
    case 'error-cause-chain': {
      const depth = pick(rng, [1, 10, 100, 1000, 5000]);
      const circular = chance(rng, 0.3);
      let error = new Error('root cause');
      const root = error;
      for (let i = 0; i < depth; i += 1) {
        error = new Error(`layer ${i}`, { cause: error });
      }
      if (circular) (root as { cause?: unknown }).cause = error;
      return {
        family,
        label: `depth${depth}${circular ? ':circular' : ''}`,
        value: error,
        describe: `Error(cause depth ${depth}${circular ? ', circular' : ''})`,
      };
    }
    case 'error-like': {
      const shape = pick(rng, [
        'plain-with-fields',
        'null-proto-with-fields',
        'error-proto-no-fields',
        'stack-only',
        'message-only',
        'name-only',
      ]);
      let value: unknown;
      switch (shape) {
        case 'plain-with-fields':
          value = { name: 'FakeError', message: 'fake', stack: 'fake\n at x' };
          break;
        case 'null-proto-with-fields': {
          const o = Object.create(null) as Record<string, unknown>;
          o['name'] = 'NullProtoError';
          o['message'] = 'no prototype';
          o['stack'] = 'NullProtoError\n    at nowhere (x:1:1)';
          value = o;
          break;
        }
        case 'error-proto-no-fields':
          value = Object.create(Error.prototype) as unknown;
          break;
        case 'stack-only':
          value = { stack: '    at only (stack:1:1)' };
          break;
        case 'message-only':
          value = { message: malformedString(rng).value.slice(0, 500) };
          break;
        default:
          value = { name: malformedString(rng).value.slice(0, 500) };
      }
      return { family, label: shape, value, describe: `error-like(${shape})` };
    }
    case 'primitive': {
      const [label, value] = pick<readonly [string, unknown]>(rng, [
        ['null', null],
        ['undefined', undefined],
        ['true', true],
        ['false', false],
        ['empty-string', ''],
        ['symbol', Symbol('thrown')],
        ['symbol-no-desc', Symbol()],
        ['symbol-wellknown', Symbol.iterator],
        ['bigint-zero', BigInt(0)],
        ['bigint-2^64', BigInt('18446744073709551616')],
        ['bigint-negative', BigInt('-9223372036854775809')],
      ]);
      return { family, label, value, describe: `primitive(${label})` };
    }
    case 'number-edge': {
      const [label, value] = pick<readonly [string, number]>(rng, [
        ['nan', NaN],
        ['neg-zero', -0],
        ['zero', 0],
        ['infinity', Infinity],
        ['neg-infinity', -Infinity],
        ['max-safe+2', Number.MAX_SAFE_INTEGER + 2],
        ['max-value', Number.MAX_VALUE],
        ['min-value', Number.MIN_VALUE],
        ['epsilon', Number.EPSILON],
        ['int32-min', -2147483648],
        ['uint32-max', 4294967295],
        ['float', 0.1 + 0.2],
        ['neg', -1],
      ]);
      return { family, label, value, describe: `number(${label})` };
    }
    case 'string-malformed': {
      const text = malformedString(rng);
      return {
        family,
        label: `${text.family}:${text.label}`,
        value: text.value,
        describe: `string(${text.family}/${text.label}, len=${text.value.length})`,
      };
    }
    case 'object-plain': {
      const shape = pick(rng, [
        'flat',
        'nested',
        'circular',
        'with-toJSON-throws',
        'with-bigint',
        'date-invalid',
        'regexp',
        'map',
        'set',
        'typed-array',
        'array-buffer',
        'promise-resolved',
        'function',
        'class',
        'array-mixed',
        'array-holes',
      ]);
      let value: unknown;
      switch (shape) {
        case 'flat':
          value = { code: 500, detail: 'internal detail leaked?' };
          break;
        case 'nested':
          value = { a: { b: { c: { d: { e: [1, { f: null }] } } } } };
          break;
        case 'circular': {
          const o: { self?: unknown; list: unknown[] } = { list: [] };
          o.self = o;
          o.list.push(o);
          value = o;
          break;
        }
        case 'with-toJSON-throws':
          value = {
            toJSON() {
              throw new Error('toJSON refused');
            },
          };
          break;
        case 'with-bigint':
          value = { n: BigInt(1) };
          break;
        case 'date-invalid':
          value = new Date(NaN);
          break;
        case 'regexp':
          value = /(a+)+$/;
          break;
        case 'map':
          value = new Map([[{}, {}]]);
          break;
        case 'set':
          value = new Set([NaN, -0, 0]);
          break;
        case 'typed-array':
          value = new Uint8Array(65536);
          break;
        case 'array-buffer':
          value = new ArrayBuffer(8);
          break;
        case 'promise-resolved':
          value = Promise.resolve('settled');
          break;
        case 'function':
          value = function hostileFn() {
            return 1;
          };
          break;
        case 'class':
          value = class HostileClass {};
          break;
        case 'array-mixed':
          value = [1, 'two', null, undefined, NaN, {}, [], Symbol('s')];
          break;
        default:
          value = new Array<unknown>(4); // holes, not undefineds
      }
      return { family, label: shape, value, describe: `object(${shape})` };
    }
    case 'object-null-proto': {
      const shape = pick(rng, ['empty', 'message', 'circular', 'bigint']);
      const o = Object.create(null) as Record<string, unknown>;
      if (shape === 'message') o['message'] = 'null proto message';
      if (shape === 'circular') o['self'] = o;
      if (shape === 'bigint') o['n'] = BigInt(7);
      return {
        family,
        label: shape,
        value: o,
        describe: `null-proto(${shape})`,
      };
    }
    case 'object-hostile-coercion': {
      const shape = pick(rng, [
        'toString-throws',
        'valueOf-throws',
        'toPrimitive-throws',
        'toString-returns-object',
        'toString-returns-symbol',
        'toString-huge',
        'toJSON-and-toString-throw',
        'toJSON-returns-bigint',
        'toJSON-circular',
      ]);
      let value: unknown;
      switch (shape) {
        case 'toString-throws':
          value = {
            toString() {
              throw new Error('toString refused');
            },
          };
          break;
        case 'valueOf-throws':
          value = {
            toString: undefined,
            valueOf() {
              throw new Error('valueOf refused');
            },
          };
          break;
        case 'toPrimitive-throws':
          value = {
            [Symbol.toPrimitive]() {
              throw new Error('toPrimitive refused');
            },
          };
          break;
        case 'toString-returns-object':
          value = { toString: () => ({}), valueOf: () => ({}) };
          break;
        case 'toString-returns-symbol':
          value = { toString: () => Symbol('s'), valueOf: () => Symbol('v') };
          break;
        case 'toString-huge':
          value = { toString: () => 'h'.repeat(1 << 20) };
          break;
        case 'toJSON-and-toString-throw':
          value = {
            toJSON() {
              throw new Error('toJSON refused');
            },
            toString() {
              throw new Error('toString refused');
            },
          };
          break;
        case 'toJSON-returns-bigint':
          value = { toJSON: () => BigInt(3), toString: () => 'ok' };
          break;
        default: {
          const o: { toJSON?: () => unknown; self?: unknown } = {};
          o.self = o;
          o.toJSON = () => o;
          value = o;
        }
      }
      return { family, label: shape, value, describe: `coercion(${shape})` };
    }
    case 'proxy': {
      const shape = pick(rng, [
        'revoked',
        'get-throws',
        'get-throws-on-error-fields',
        'has-throws',
        'getPrototypeOf-throws',
        'ownKeys-throws',
        'error-target-get-throws',
        'transparent',
      ]);
      let value: unknown;
      switch (shape) {
        case 'revoked': {
          const { proxy, revoke } = Proxy.revocable({}, {});
          revoke();
          value = proxy;
          break;
        }
        case 'get-throws':
          value = new Proxy(
            {},
            {
              get() {
                throw new Error('proxy get refused');
              },
            },
          );
          break;
        case 'get-throws-on-error-fields':
          value = new Proxy(
            {},
            {
              get(_t, key) {
                if (key === 'name' || key === 'message' || key === 'stack') {
                  throw new Error(`proxy refused ${String(key)}`);
                }
                return undefined;
              },
            },
          );
          break;
        case 'has-throws':
          value = new Proxy(
            {},
            {
              has() {
                throw new Error('proxy has refused');
              },
            },
          );
          break;
        case 'getPrototypeOf-throws':
          value = new Proxy(
            {},
            {
              getPrototypeOf() {
                throw new Error('proxy getPrototypeOf refused');
              },
            },
          );
          break;
        case 'ownKeys-throws':
          value = new Proxy(
            {},
            {
              ownKeys() {
                throw new Error('proxy ownKeys refused');
              },
            },
          );
          break;
        case 'error-target-get-throws':
          value = new Proxy(new Error('proxied'), {
            get(target, key, receiver) {
              if (key === 'stack') throw new Error('proxy stack refused');
              return Reflect.get(target, key, receiver) as unknown;
            },
          });
          break;
        default:
          value = new Proxy(new Error('transparent proxy'), {});
      }
      return { family, label: shape, value, describe: `proxy(${shape})` };
    }
    case 'proto-pollution': {
      const key = pick(rng, PROTO_KEYS);
      const shape = pick(rng, ['parsed', 'literal-own', 'nested', 'array']);
      let value: unknown;
      switch (shape) {
        case 'parsed':
          value = JSON.parse(`{"${key}":{"polluted":true}}`) as unknown;
          break;
        case 'literal-own': {
          const o: Record<string, unknown> = {};
          Object.defineProperty(o, key, {
            value: { polluted: true },
            enumerable: true,
            configurable: true,
          });
          value = o;
          break;
        }
        case 'nested':
          value = JSON.parse(
            `{"a":{"${key}":{"${key}":{"polluted":1}}}}`,
          ) as unknown;
          break;
        default:
          value = JSON.parse(`[{"${key}":{"polluted":true}}]`) as unknown;
      }
      return {
        family,
        label: `${key}:${shape}`,
        value,
        describe: `proto-pollution(${key}, ${shape})`,
      };
    }
    case 'empty-collection': {
      const [label, value] = pick<readonly [string, unknown]>(rng, [
        ['empty-object', {}],
        ['empty-array', []],
        ['empty-map', new Map()],
        ['empty-set', new Set()],
        ['empty-null-proto', Object.create(null)],
        ['empty-frozen', Object.freeze({})],
        ['empty-string-array', ['']],
        ['nested-empties', [[], {}, [[]], [{}]]],
      ]);
      return { family, label, value, describe: `empty(${label})` };
    }
    case 'exotic': {
      const [label, value] = pick<readonly [string, unknown]>(rng, [
        ['weakref', new WeakRef({})],
        ['weakmap', new WeakMap()],
        ['dataview', new DataView(new ArrayBuffer(4))],
        ['arguments-like', { length: 2, 0: 'a', 1: 'b' }],
        ['boxed-string', new String('boxed')],
        ['boxed-number', new Number(NaN)],
        ['boxed-boolean', new Boolean(false)],
        ['symbol-object', Object(Symbol('boxed'))],
        ['bigint-object', Object(BigInt(9))],
        [
          'generator',
          (function* gen() {
            yield 1;
          })(),
        ],
        ['async-fn', async () => undefined],
        ['bound-fn', function bound() {}.bind(null)],
        ['error-array', [new Error('a'), new Error('b')]],
        ['error-in-object', { error: new Error('nested') }],
        ['url-search-params-like', { toString: () => 'a=1&b=2' }],
        ['huge-array', new Array(100000).fill(0)],
      ]);
      return { family, label, value, describe: `exotic(${label})` };
    }
  }
}

/** All string families, for coverage accounting in the result tables. */
export const STRING_FAMILIES: readonly StringFamily[] = [
  'json-malformed',
  'json-truncated',
  'proto-pollution',
  'path-traversal',
  'null-bytes',
  'huge-bytes',
  'huge-codepoints',
  'huge-graphemes',
  'unicode-normalization',
  'unicode-control',
  'future-schema',
  'numeric-text',
  'empty-or-space',
  'uuid-lookalike',
];

export const THROWABLE_FAMILIES: readonly ThrowableFamily[] = [
  'error-plain',
  'error-huge',
  'error-corrupt-field',
  'error-throwing-getter',
  'error-subclass',
  'error-frozen',
  'error-cause-chain',
  'error-like',
  'primitive',
  'number-edge',
  'string-malformed',
  'object-plain',
  'object-null-proto',
  'object-hostile-coercion',
  'proxy',
  'proto-pollution',
  'empty-collection',
  'exotic',
];

/**
 * Best-effort, never-throwing description of an arbitrary value for result
 * tables. Hostile values (throwing getters, revoked proxies) are reported by
 * their failure instead of propagating it.
 */
export function safeDescribe(value: unknown): string {
  try {
    if (value === null) return 'null';
    if (typeof value === 'string') {
      return `string(len=${value.length})${
        value.length <= 80 ? `:${JSON.stringify(value)}` : ''
      }`;
    }
    if (typeof value === 'symbol') return `symbol(${value.description ?? ''})`;
    if (typeof value === 'bigint') return `bigint(${value.toString()})`;
    if (typeof value === 'function') return `function(${value.name})`;
    if (typeof value !== 'object') return `${typeof value}(${String(value)})`;
    if (value instanceof Error) {
      return `Error(name=${typeof value.name}, message=${typeof value.message}, stack=${typeof value.stack})`;
    }
    return `object(${Object.prototype.toString.call(value)})`;
  } catch (error) {
    return `<indescribable: ${error instanceof Error ? error.message : typeof error}>`;
  }
}
